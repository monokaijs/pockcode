import type * as Monaco from "monaco-editor"

export type MonacoApi = typeof Monaco

type SyntaxOnlyDiagnosticsOptions = {
  noSemanticValidation: boolean
  noSuggestionDiagnostics: boolean
  noSyntaxValidation: boolean
}

export function configureMonacoLanguageDefaults(monaco: MonacoApi): void {
  const typescriptLanguage = monaco.languages.typescript as unknown as {
    javascriptDefaults?: { setDiagnosticsOptions: (options: SyntaxOnlyDiagnosticsOptions) => void }
    typescriptDefaults?: { setDiagnosticsOptions: (options: SyntaxOnlyDiagnosticsOptions) => void }
  }
  const syntaxOnlyDiagnostics = {
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: false,
  }

  typescriptLanguage.typescriptDefaults?.setDiagnosticsOptions(syntaxOnlyDiagnostics)
  typescriptLanguage.javascriptDefaults?.setDiagnosticsOptions(syntaxOnlyDiagnostics)
}
