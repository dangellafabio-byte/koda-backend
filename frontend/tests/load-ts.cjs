// Use Node's built-in TS stripping, or the project's existing dev dependency.
const nativeStrip = require('node:module').stripTypeScriptTypes;
exports.stripTypeScriptTypes = typeof nativeStrip === 'function'
  ? nativeStrip
  : source => {
      const ts = require('typescript');
      return ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    };
