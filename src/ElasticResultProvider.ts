import * as vscode from 'vscode';

export class ElasticResultProvider implements vscode.TextDocumentContentProvider {
    private _results: string = "";
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    static scheme = 'elastic-result';
    static uri = vscode.Uri.parse(`${ElasticResultProvider.scheme}://results.json`);

    public update(results: string) {
        this._results = results;
        this._onDidChange.fire(ElasticResultProvider.uri);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this._results;
    }
}
