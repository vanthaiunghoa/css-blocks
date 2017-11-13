import * as fs from 'fs';
import * as path from 'path';

import * as babylon from 'babylon';
import * as typescript from 'typescript';
import traverse from 'babel-traverse';
import {
  Block,
  MultiTemplateAnalyzer,
  PluginOptions as CssBlocksOptions,
  BlockFactory,
  PluginOptionsReader as CssBlocksOptionsReader
} from 'css-blocks';

import importer from './importer';
import analyzer from './analyzer';
import CSSBlocksJSXTransformer from './transformer';
import Analysis, { JSXTemplate, MetaAnalysis } from './utils/Analysis';
import { JSXParseError } from './utils/Errors';

// `Object.values` does not exist in node<=7.0.0, load a polyfill if needed.
if (!(<any>Object).values) {
  require('object.values').shim();
}

/**
 * Default parser options.
 */

 export interface JSXAnalyzerOptions {
   baseDir: string;
   parserOptions?: object;
   aliases?: { [alias: string]: string };
   compilationOptions?: CssBlocksOptions;
 }

const defaultOptions: JSXAnalyzerOptions = {
  baseDir: '.',
  parserOptions: {
    sourceType: 'module',
    plugins: [
      'jsx',
      'flow',
      'decorators',
      'classProperties',
      'exportExtensions',
      'asyncGenerators',
      'functionBind',
      'functionSent',
      'dynamicImport'
    ]
  },
  aliases: {}
};

export function parseWith(template: JSXTemplate, metaAnalysis: MetaAnalysis, factory: BlockFactory, opts: JSXAnalyzerOptions = defaultOptions): Promise<Analysis> {

  // Ensure default options.
  opts = Object.assign({}, defaultOptions, opts);

  // Change our process working directory so relative node resolves work.
  let oldDir = process.cwd();
  process.chdir(opts.baseDir);

  let analysis: Analysis = new Analysis(template, metaAnalysis);

  // Parse the file into an AST.
  try {

    // Babylon currently has...abysmal support for typescript. We need to transpile
    // it with the standard typescript library first.
    // TODO: When Typescript support lands in Babylon, remove this: https://github.com/babel/babylon/issues/320
    if ( path.parse(template.identifier).ext === '.tsx') {
      let wat = typescript.transpileModule(template.data, {
        compilerOptions: {
          module: typescript.ModuleKind.ES2015,
          jsx: typescript.JsxEmit.Preserve,
          target: typescript.ScriptTarget.Latest
        }
      });
      template.data = wat.outputText;
    }

    analysis.template.ast = babylon.parse(template.data, opts.parserOptions);
  } catch (e) {
    throw new JSXParseError(`Error parsing '${template.identifier}'\n${e.message}\n\n${template.data}.`, { filename: template.identifier });
  }

  // The blocks importer will insert a promise that resolves to a `ResolvedBlock`
  // for each CSS Blocks import it encounters.
  traverse(analysis.template.ast, importer(template, analysis, factory, opts));

  // Once all blocks this file is waiting for resolve, resolve with the File object.
  let analysisPromise = Promise.all(analysis.blockPromises)
  .then((blocks: Block[]) => {
    return analysis;
  });

  // After import traversal, it is safe to move back to our old working directory.
  process.chdir(oldDir);

  // Add this file promise to the list of dependents waiting to resolve.
  metaAnalysis.analysisPromises.push(analysisPromise);
  return analysisPromise;

}

/**
 * Provided a file path, return a promise for the parsed Template object.
 * // TODO: Make streaming?
 * @param file The file path to read in and parse.
 * @param opts Optional analytics parser options.
 */
export function parseFileWith(file: string, metaAnalysis: MetaAnalysis, factory: BlockFactory, opts: JSXAnalyzerOptions = defaultOptions): Promise<Analysis> {

  // Ensure default options.
  opts = Object.assign({}, defaultOptions, opts);

  // If requesting the file at a relative path, resolve to provided `opts.baseDir`.
  if ( file && !path.isAbsolute(file) ) {
    file = path.resolve(opts.baseDir, file);
  }

  // Fetch file contents from the now absolute path.
  let data: string;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new JSXParseError(`Cannot read JSX entrypoint file ${file}`, { filename: file });
  }

  // Return promise for parsed analysis object.
  let template: JSXTemplate = new JSXTemplate(file, data);

  return parseWith(template, metaAnalysis, factory, opts);
}
/**
 * Provided a code string, return a promise for the fully parsed analytics object.
 * @param data The code string to parse.
 * @param opts Optional analytics parser options.
 */
export function parse(data: string, factory: BlockFactory, opts: JSXAnalyzerOptions = defaultOptions): Promise<MetaAnalysis> {

  // Ensure default options.
  opts = Object.assign({}, defaultOptions, opts);

  let template: JSXTemplate = new JSXTemplate('', data);
  let metaAnalysis: MetaAnalysis = new MetaAnalysis();

  return Promise.resolve().then(() => {
    parseWith(template, metaAnalysis, factory, opts);
    return Promise.all(metaAnalysis.analysisPromises).then((analyses) => {
      analyses.forEach((analysis) => {
        traverse(analysis.template.ast, analyzer(analysis));
        metaAnalysis.addAnalysis(analysis);
        // No need to keep detailed template data anymore!
        delete analysis.template.ast;
        delete analysis.template.data;
      });
      return metaAnalysis;
    });
  });
}

/**
 * Provided a file path, return a promise for the fully parsed analytics object.
 * // TODO: Make streaming?
 * @param file The file path to read in and parse.
 * @param opts Optional analytics parser options.
 */
export function parseFile(file: string, factory: BlockFactory, opts: JSXAnalyzerOptions = defaultOptions): Promise<MetaAnalysis> {

  // Ensure default options.
  opts = Object.assign({}, defaultOptions, opts);

  // If requesting the file at a relative path, resolve to provided `opts.baseDir`.
  if ( file && !path.isAbsolute(file) ) {
    file = path.resolve(opts.baseDir, file);
  }

  // Fetch file contents from the now absolute path.
  let data: string;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new JSXParseError(`Cannot read JSX entrypoint file ${file}`, { filename: file });
  }

  // Return promise for parsed analysis object.
  let template: JSXTemplate = new JSXTemplate(file, data);
  let metaAnalysis: MetaAnalysis = new MetaAnalysis();

  return Promise.resolve().then(() => {
    parseWith(template, metaAnalysis, factory, opts);
    return Promise.all(metaAnalysis.analysisPromises).then((analyses) => {
      analyses.forEach((analysis) => {
        traverse(analysis.template.ast, analyzer(analysis));
        metaAnalysis.addAnalysis(analysis);
        // No need to keep detailed template data anymore!
        delete analysis.template.ast;
        delete analysis.template.data;
      });
      return metaAnalysis;
    });
  });
}

export class CSSBlocksJSXAnalyzer implements MultiTemplateAnalyzer {
  private _blockFactory: BlockFactory;
  private entrypoint: string;
  private name: string;
  private options: JSXAnalyzerOptions;
  private cssBlocksOptions: CssBlocksOptionsReader;

  constructor(entrypoint: string, name: string, options: JSXAnalyzerOptions){
    this.entrypoint = entrypoint;
    this.name = name;
    this.options = options;
    this.cssBlocksOptions = new CssBlocksOptionsReader(options.compilationOptions || {});
    this._blockFactory = this.cssBlocksOptions.factory || new BlockFactory(this.cssBlocksOptions);
  }
  analyze(): Promise<MetaAnalysis> {
    if ( !this.entrypoint || !this.name ) {
      throw new JSXParseError('CSS Blocks JSX Analyzer must be passed an entrypoint and name.');
    }
    return parseFile(this.entrypoint, this.blockFactory, this.options);
  }

  reset() {
    this._blockFactory.reset();
  }

  get blockFactory() {
    return this._blockFactory;
  }
}

export default {
  Analyzer: CSSBlocksJSXAnalyzer,
  Rewriter: CSSBlocksJSXTransformer
};
