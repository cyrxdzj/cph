import { Problem, RunResult } from '../types';
import { getInputOriginFilenameFromInput, getLanguage } from '../utils';
import { getBinSaveLocation, compileFile } from '../compiler';
import { saveProblem } from '../parser';
import { runTestCase, deleteBinary } from '../executions';
import { isResultCorrect } from '../judge';
import * as vscode from 'vscode';
import { getJudgeViewProvider } from '../extension';
import { getIgnoreSTDERRORPref } from '../preferences';
import telmetry from '../telmetry';
import { readFile } from 'fs';
import path from 'path';

export const runSingleAndSave = async (
    problem: Problem,
    id: number,
    skipCompile = false,
    skipTelemetry = false,
) => {
    const input_file_name = problem.input_file_name, output_file_name = problem.output_file_name;
    if (input_file_name.indexOf("/") != -1) {
        vscode.window.showErrorMessage(
            `For security reason, input_file_name shouldn't contain '/'.`,
        );
        return;
    }
    if (output_file_name.indexOf("/") != -1) {
        vscode.window.showErrorMessage(
            `For security reason, output_file_name shouldn't contain '/'.`,
        );
        return;
    }
    if (!skipTelemetry) {
        globalThis.reporter.sendTelemetryEvent(telmetry.RUN_TESTCASE);
    }
    globalThis.logger.log('Run and save started', problem, id);
    const srcPath = problem.srcPath;
    const language = getLanguage(srcPath);
    const binPath = getBinSaveLocation(srcPath);
    const idx = problem.tests.findIndex((value) => value.id === id);
    const testCase = problem.tests[idx];

    const textEditor = await vscode.workspace.openTextDocument(srcPath);
    await vscode.window.showTextDocument(textEditor, vscode.ViewColumn.One);
    await textEditor.save();

    if (!testCase) {
        globalThis.logger.error('Invalid id', id, problem);
        return;
    }

    saveProblem(srcPath, problem);

    if (!skipCompile) {
        if (!(await compileFile(srcPath))) {
            globalThis.logger.error('Failed to compile', problem, id);
            return;
        }
    }

    const input_origin_file_name = getInputOriginFilenameFromInput(testCase.input);
    const answer_origin_file_name = getInputOriginFilenameFromInput(testCase.output);
    if (input_origin_file_name.indexOf("/") != -1) {
        vscode.window.showErrorMessage(
            `For security reason, input_origin_file_name shouldn't contain '/'.`,
        );
        return;
    }
    if (answer_origin_file_name.indexOf("/") != -1) {
        vscode.window.showErrorMessage(
            `For security reason, answer_origin_file_name shouldn't contain '/'.`,
        );
        return;
    }
    if (input_origin_file_name != "") {
        const input_origin_file_path = path.join(path.parse(binPath).dir, input_origin_file_name);
        await readFile(input_origin_file_path, (err, data) => {
            if (!err) {
                testCase.input = data.toString();
            }
            else {
                vscode.window.showErrorMessage("An error occurred when read input from " + input_origin_file_name + "\n" + err.stack);
                console.error('ERR', err);
            }
        });
    }
    if (answer_origin_file_name != "") {
        const answer_origin_file_path = path.join(path.parse(binPath).dir, answer_origin_file_name);
        await readFile(answer_origin_file_path, (err, data) => {
            if (!err) {
                testCase.output = data.toString();
            }
            else {
                globalThis.logger.log("An error occurred when read answer content from " + answer_origin_file_path + "\n" + err.stack);
            }
        });
    }

    const run = await runTestCase(language, binPath, testCase.input, input_file_name, output_file_name);

    if (!skipCompile) {
        deleteBinary(language, binPath);
    }

    const stderrorFailure = getIgnoreSTDERRORPref() ? false : run.stderr !== '';

    const didError =
        (run.code !== null && run.code !== 0) ||
        run.signal !== null ||
        stderrorFailure;
    const result: RunResult = {
        ...run,
        pass: didError ? false : isResultCorrect(testCase, run.stdout),
        id,
    };

    globalThis.logger.log('Testcase judging complete. Result:', result);
    getJudgeViewProvider().extensionToJudgeViewMessage({
        command: 'run-single-result',
        result,
        problem,
    });
};
