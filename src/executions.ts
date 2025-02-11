import { Language, Run } from './types';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { platform } from 'os';
import config from './config';
import { getTimeOutPref } from './preferences';
import * as vscode from 'vscode';
import path from 'path';
import { onlineJudgeEnv } from './compiler';
import telmetry from './telmetry';
import * as fs from "fs";
import { getInputOriginFilenameFromInput } from './utils';
const runningBinaries: ChildProcessWithoutNullStreams[] = [];

/**
 * Run a single testcase, and return the raw results, without judging.
 *
 * @param binPath path to the executable binary
 * @param input string to be piped into the stdin of the spawned process
 */
export const runTestCase = (
    language: Language,
    binPath: string,
    input: string,
    input_file_name: string = "",
    output_file_name: string = "",
): Promise<Run> => {
    globalThis.logger.log('Running testcase', language, binPath, input, input_file_name, output_file_name);
    const result: Run = {
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        time: 0,
        timeOut: false,
    };

    const binDir = path.dirname(binPath);
    const spawnOpts = {
        timeout: config.timeout,
        env: {
            ...global.process.env,
            DEBUG: 'true',
            CPH: 'true',
        },
        cwd: binDir
    };

    const input_origin_file_name = getInputOriginFilenameFromInput(input);
    if (input_origin_file_name != "") {
        globalThis.logger.log("input_origin_file_name", input_origin_file_name);
    }

    let process: ChildProcessWithoutNullStreams;

    const killer = setTimeout(() => {
        result.timeOut = true;
        process.kill();
    }, getTimeOutPref());

    // HACK - On Windows, `python3` will be changed to `python`!
    if (platform() === 'win32' && language.compiler === 'python3') {
        language.compiler = 'python';
    }

    // Start the binary or the interpreter.
    switch (language.name) {
        case 'python': {
            process = spawn(
                language.compiler, // 'python3' or 'python' TBD
                [binPath, ...language.args],
                spawnOpts,
            );
            break;
        }
        case 'ruby': {
            process = spawn(
                language.compiler,
                [binPath, ...language.args],
                spawnOpts,
            );
            break;
        }
        case 'js': {
            process = spawn(
                language.compiler,
                [binPath, ...language.args],
                spawnOpts,
            );
            break;
        }
        case 'java': {
            const args: string[] = [];
            if (onlineJudgeEnv) {
                args.push('-DONLINE_JUDGE');
            }

            const binDir = path.dirname(binPath);
            args.push('-cp');
            args.push(binDir);

            const binFileName = path.parse(binPath).name.slice(0, -1);
            args.push(binFileName);

            process = spawn('java', args, { cwd: binDir });
            break;
        }
        case 'csharp': {
            let binFileName: string;

            if (language.compiler.includes('dotnet')) {
                const projName = '.cphcsrun';
                const isLinux = platform() == 'linux';
                if (isLinux) {
                    binFileName = projName;
                } else {
                    binFileName = projName + '.exe';
                }

                const binFilePath = path.join(binPath, binFileName);
                process = spawn(binFilePath, ['/stack:67108864'], spawnOpts);
            } else {
                // Run with mono
                process = spawn('mono', [binPath], spawnOpts);
            }

            break;
        }
        default: {
            const binDir = path.dirname(binPath);
            process = spawn(binPath, spawnOpts);
        }
    }

    process.on('error', (err) => {
        globalThis.logger.error(err);
        vscode.window.showErrorMessage(
            `Could not launch testcase process. Is '${language.compiler}' in your PATH?`,
        );
    });

    const begin = Date.now();
    const ret: Promise<Run> = new Promise((resolve) => {
        runningBinaries.push(process);
        process.on('exit', (code, signal) => {
            const end = Date.now();
            clearTimeout(killer);
            result.code = code;
            result.signal = signal;
            result.time = end - begin;
            runningBinaries.pop();
            globalThis.logger.log('Run Result:', result);
            if (output_file_name != "") {
                const output_file_path = path.join(path.parse(binPath).dir, output_file_name);
                fs.readFile(output_file_path, (err, data) => {
                    if (err) {
                        vscode.window.showErrorMessage("An error occurred when read output content to " + output_file_path + "\n" + err.stack);
                        console.error('ERR', err);
                    }
                    result.stdout = data.toString();
                    resolve(result);
                })
            }
            else {
                resolve(result);
            }
        });

        process.stdout.on('data', (data) => {
            result.stdout += data;
        });
        process.stderr.on('data', (data) => (result.stderr += data));

        if (input_file_name == "") {
            globalThis.logger.log('Wrote to STDIN');
            if (input_origin_file_name == "") {
                try {
                    process.stdin.write(input);
                } catch (err) {
                    console.error('WRITEERROR', err);
                }
            }
            else {
                const input_origin_file_path = path.join(path.parse(binPath).dir, input_origin_file_name);
                fs.readFile(input_origin_file_path, (err, data) => {
                    if (err) {
                        vscode.window.showErrorMessage("An error occurred when read input from " + input_origin_file_name + "\n" + err.stack);
                        console.error('ERR', err);
                    }
                    try {
                        process.stdin.write(data);
                    } catch (err) {
                        console.error('WRITEERROR', err);
                    }
                });
            }
        }
        else {
            globalThis.logger.log("Write to " + input_file_name);
            const input_file_path = path.join(path.parse(binPath).dir, input_file_name);
            const input_origin_file_path = path.join(path.parse(binPath).dir, input_origin_file_name);
            globalThis.logger.log("input_file_path", input_file_path);
            if (input_origin_file_name == "") {
                fs.writeFile(input_file_path, input, (err) => {
                    if (err) {
                        vscode.window.showErrorMessage("An error occurred when write input content to " + input_file_path + "\n" + err.stack);
                        console.error('WRITEERROR', err);
                    }
                })
            }
            else {
                fs.copyFile(input_origin_file_path, input_file_path, (err) => {
                    if (err) {
                        vscode.window.showErrorMessage("An error occurred when copy input content from " + input_origin_file_path + " to " + input_file_path + "\n" + err.stack);
                        console.error('WRITEERROR', err);
                    }
                });
            }
        }

        process.stdin.end();
        process.on('error', (err) => {
            const end = Date.now();
            clearTimeout(killer);
            result.code = 1;
            result.signal = err.name;
            result.time = end - begin;
            runningBinaries.pop();
            globalThis.logger.log('Run Error Result:', result);
            resolve(result);
        });
    });

    return ret;
};

/** Remove the generated binary from the file system, if present */
export const deleteBinary = (language: Language, binPath: string) => {
    if (language.skipCompile) {
        globalThis.logger.log(
            "Skipping deletion of binary as it's not a compiled language.",
        );
        return;
    }
    globalThis.logger.log('Deleting binary', binPath);
    try {
        const isLinux = platform() == 'linux';
        const isFile = path.extname(binPath);

        if (isLinux) {
            if (isFile) {
                spawn('rm', [binPath]);
            } else {
                spawn('rm', ['-r', binPath]);
            }
        } else {
            const nrmBinPath = '"' + binPath + '"';
            if (isFile) {
                spawn('cmd.exe', ['/c', 'del', nrmBinPath], {
                    windowsVerbatimArguments: true,
                });
            } else {
                spawn('cmd.exe', ['/c', 'rd', '/s', '/q', nrmBinPath], {
                    windowsVerbatimArguments: true,
                });
            }
        }
    } catch (err) {
        globalThis.logger.error('Error while deleting binary', err);
    }
};

/** Kill all running binaries. Usually, only one should be running at a time. */
export const killRunning = () => {
    globalThis.reporter.sendTelemetryEvent(telmetry.KILL_RUNNING);
    globalThis.logger.log('Killling binaries');
    runningBinaries.forEach((process) => process.kill());
};
