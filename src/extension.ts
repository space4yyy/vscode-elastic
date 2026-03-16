import * as vscode from 'vscode';
import path = require('path');
import * as fs from 'fs';
import * as os from 'os';
import { ElasticCompletionItemProvider } from './ElasticCompletionItemProvider';
import { ElasticCodeLensProvider } from './ElasticCodeLensProvider';
import { ElasticContentProvider } from './ElasticContentProvider';
import { ElasticDecoration } from './ElasticDecoration';
import { ElasticMatch } from './ElasticMatch';
import { ElasticMatches } from './ElasticMatches';
import axios, { AxiosError, AxiosResponse } from 'axios';
import stripJsonComments from './helpers';
import { JsonPanel } from './jsonPanel';
const jsonPanel = new JsonPanel();

export async function activate(context: vscode.ExtensionContext) {
    getHost(context);
    const languages = ['es', 'elasticsearch'];
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(languages, new ElasticCodeLensProvider(context)));

    let resultsProvider = new ElasticContentProvider();
    vscode.workspace.registerTextDocumentContentProvider('elasticsearch', resultsProvider);

    let esMatches: ElasticMatches;
    let decoration: ElasticDecoration;

    function checkEditor(document: vscode.TextDocument): Boolean {
        if (document === vscode.window.activeTextEditor!.document && document.languageId == 'es') {
            if (esMatches == null || decoration == null) {
                esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
                decoration = new ElasticDecoration(context);
            }
            return true;
        }
        return false;
    }

    if (vscode.window.activeTextEditor && checkEditor(vscode.window.activeTextEditor!.document)) {
        esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
        decoration!.UpdateDecoration(esMatches);
    }

    vscode.workspace.onDidChangeTextDocument(e => {
        if (checkEditor(e.document)) {
            esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
            decoration.UpdateDecoration(esMatches);
        }
    });

    vscode.window.onDidChangeTextEditorSelection(e => {
        if (checkEditor(e.textEditor.document)) {
            esMatches.UpdateSelection(e.textEditor);
            decoration.UpdateDecoration(esMatches);
        }
    });
    let esCompletionHover = new ElasticCompletionItemProvider(context);

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(languages, esCompletionHover, '/', '?', '&', '"'));
    context.subscriptions.push(vscode.languages.registerHoverProvider(languages, esCompletionHover));

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.execute', (em: ElasticMatch) => {
            if (!esMatches && vscode.window.activeTextEditor) {
                checkEditor(vscode.window.activeTextEditor.document);
            }
            if (!em && esMatches) {
                em = esMatches.Selection;
            }
            if (em) {
                executeQuery(context, resultsProvider, em);
            } else {
                vscode.window.showErrorMessage('No active Elasticsearch query selection.');
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.setHost', () => {
            setHost(context);
        }),
    );

    vscode.commands.registerCommand('extension.setClip', (uri, query) => {
        // var ncp = require('copy-paste');
        // ncp.copy(query, function () {
        // vscode.window.showInformationMessage('Copied to clipboard');
        // });
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.open', (em: ElasticMatch) => {
            var column = 0;
            let uri = vscode.Uri.file(em.File.Text);
            return vscode.workspace
                .openTextDocument(uri)
                .then(textDocument =>
                    vscode.window.showTextDocument(
                        textDocument,
                        column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined,
                        true,
                    ),
                );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lint', (em: ElasticMatch) => {
            try {
                let l = em.Method.Range.start.line + 1;
                const editor = vscode.window.activeTextEditor;
                const config = vscode.workspace.getConfiguration('editor');
                const tabSize = +(config.get('tabSize') as number);

                editor!.edit(editBuilder => {
                    if (em.HasBody) {
                        let txt = editor!.document.getText(em.Body.Range);
                        editBuilder.replace(em.Body.Range, JSON.stringify(JSON.parse(em.Body.Text), null, tabSize));
                    }
                });
            } catch (error: any) {
                console.log(error.message);
            }
        }),
    );

    // Create the global status bar item
    hostStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    hostStatusBarItem.command = 'extension.setHost';
    context.subscriptions.push(hostStatusBarItem);
    
    // Initialize its value
    updateStatusBar(context);
    
    // Show it if we are currently handling an ES file, otherwise hide
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'es') {
        hostStatusBarItem.show();
    }
    
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.languageId === 'es') {
            hostStatusBarItem.show();
        } else {
            hostStatusBarItem.hide();
        }
    });
}

// Global variable for our status bar item
let hostStatusBarItem: vscode.StatusBarItem;

export function updateStatusBar(context: vscode.ExtensionContext) {
    if (!hostStatusBarItem) return;
    
    const host = getHost(context);
    const environments: any = vscode.workspace.getConfiguration().get('elastic.environments') || {};
    
    // Try to find if the current host matches any named environment
    let matchedEnvName = null;
    for (const [name, url] of Object.entries(environments)) {
        if (url === host) {
            matchedEnvName = name;
            break;
        }
    }
    
    // Set the status bar text
    if (matchedEnvName) {
        hostStatusBarItem.text = `$(database) ES: ${matchedEnvName}`;
    } else {
        // Truncate host if it's too long
        const displayHost = host.length > 25 ? host.substring(0, 22) + '...' : host;
        hostStatusBarItem.text = `$(database) ES: ${displayHost}`;
    }
    
    hostStatusBarItem.tooltip = `Current Elasticsearch Host: ${host}\nClick to change configuration.`;
}

async function setHost(context: vscode.ExtensionContext): Promise<string> {
    const environments: any = vscode.workspace.getConfiguration().get('elastic.environments') || {};
    const items: vscode.QuickPickItem[] = Object.keys(environments).map(name => ({
        label: name,
        description: environments[name]
    }));
    items.push({ label: 'Enter manually...', description: 'Type the host URL directly' });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an Elasticsearch environment',
        ignoreFocusOut: true
    });

    let host = getHost(context);
    if (!selected) {
        return host;
    }

    if (selected.label === 'Enter manually...') {
        const inputHost = await vscode.window.showInputBox(<vscode.InputBoxOptions>{
            prompt: 'Please enter the elastic host',
            ignoreFocusOut: true,
            value: host,
        });
        if (inputHost) {
            host = inputHost;
            
            // Ask if they want to save this new host configuration
            const envName = await vscode.window.showInputBox({
                prompt: 'Save this environment as (leave blank to use temporarily without saving)',
                ignoreFocusOut: true,
                placeHolder: 'e.g., prod, staging, my-cluster'
            });

            if (envName && envName.trim() !== '') {
                const config = vscode.workspace.getConfiguration();
                const currentEnvs: any = config.get('elastic.environments') || {};
                currentEnvs[envName.trim()] = host;
                
                // Save to global user settings (true flag)
                await config.update('elastic.environments', currentEnvs, true);
                vscode.window.showInformationMessage(`Saved new environment '${envName.trim()}' -> ${host}`);
            }
        } else {
            return host;
        }
    } else {
        host = selected.description || host;
    }

    context.workspaceState.update('elasticsearch.host', host);
    vscode.workspace.getConfiguration().update('elasticsearch.host', host);
    vscode.window.showInformationMessage(`Elasticsearch host set to ${selected.label !== 'Enter manually...' ? selected.label + ' (' + host + ')' : host}`);
    
    updateStatusBar(context);
    return host || 'localhost:9200';
}

export function getHost(context: vscode.ExtensionContext): string {
    return context.workspaceState.get('elasticsearch.host') || vscode.workspace.getConfiguration().get('elasticsearch.host') || vscode.workspace.getConfiguration().get('elastic.host', 'localhost:9200');
}

export async function executeQuery(context: vscode.ExtensionContext, resultsProvider: ElasticContentProvider, em: ElasticMatch) {
    const host = getHost(context);
    const startTime = new Date().getTime();

    const config = vscode.workspace.getConfiguration();
    var asDocument = config.get('elasticsearch.showResultAsDocument');

    const sbi = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbi.text = '$(search) Executing query ...';
    sbi.show();

    let response: any;
    try {
        const body = stripJsonComments(em.Body.Text);
        const hostStr = host.trim();
        let url = (hostStr.startsWith('http://') || hostStr.startsWith('https://'))
            ? hostStr
            : 'http://' + hostStr;
        url += (em.Path.Text.startsWith('/') ? '' : '/') + em.Path.Text;

        const requestConfig: any = {
            url,
            method: em.Method.Text as any,
            headers: { 'Content-Type': em.IsBulk ? 'application/x-ndjson' : 'application/json' },
        };

        if (body && body !== '""' && body.trim() !== '') {
            requestConfig.data = body;
        }

        response = await axios(requestConfig).catch(error => error as AxiosError<any, any>);
    } catch (error) {
        response = error;
    }

    sbi.dispose();
    const endTime = new Date().getTime();
    const error = response as AxiosError;
    const data = response as AxiosResponse<any>;

    let results = data.data;
    if (!results) results = data;
    if (asDocument) {
        try {
            const config = vscode.workspace.getConfiguration('editor');
            const tabSize = +(config.get('tabSize') as number);
            let rawData = (error && error.isAxiosError) ? error.response?.data : data.data;
            results = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, tabSize);
        } catch (error: any) {
            results = data.data || error.response?.data || error.message;
        }
        showResult(results, vscode.window.activeTextEditor!.viewColumn! + 1);
    } else {
        jsonPanel.render(results, `ElasticSearch Results[${endTime - startTime}ms]`);
    }
}

function showResult(result: string, column?: vscode.ViewColumn): Thenable<void> {
    const tempResultFilePath = path.join(os.homedir(), '.vscode-elastic');
    const resultFilePath = vscode.workspace.rootPath || tempResultFilePath;

    let uri = vscode.Uri.file(path.join(resultFilePath, 'result.json'));
    if (!fs.existsSync(uri.fsPath)) {
        uri = uri.with({ scheme: 'untitled' });
    }
    return vscode.workspace
        .openTextDocument(uri)
        .then(textDocument =>
            vscode.window.showTextDocument(textDocument, column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined, true),
        )
        .then(editor => {
            editor.edit(editorBuilder => {
                if (editor.document.lineCount > 0) {
                    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                    editorBuilder.delete(
                        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine.range.start.line, lastLine.range.end.character)),
                    );
                }
                editorBuilder.insert(new vscode.Position(0, 0), result);
            });
        });
}

// this method is called when your extension is deactivated
export function deactivate() { }
