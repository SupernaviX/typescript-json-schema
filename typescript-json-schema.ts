import * as ts from "typescript";
import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";


const vm = require("vm");

export module TJS {
    export function getDefaultArgs() {
        return {
            useRef: true,
            useTypeAliasRef: false,
            useRootRef: false,
            useTitle: false,
            useDefaultProperties: false,
            disableExtraProperties: false,
            usePropertyOrder: false,
            generateRequired: false,
            out: undefined
        };
    }

    class JsonSchemaGenerator {
        private static validationKeywords = [
            "ignore", "description", "type", "minimum", "exclusiveMinimum", "maximum",
            "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "format",
            "pattern", "minItems", "maxItems", "uniqueItems", "default",
            "additionalProperties", "enum"];

        private static annotedValidationKeywordPattern = /@[a-z.-]+\s*[^@]+/gi;
        //private static primitiveTypes = ["string", "number", "boolean", "any"];

        private allSymbols: { [name: string]: ts.Type };
        private inheritingTypes: { [baseName: string]: string[] };
        private tc: ts.TypeChecker;

        private sandbox = { sandboxvar: null };

        private reffedDefinitions: { [key: string]: any } = {};

        constructor(allSymbols: { [name: string]: ts.Type }, inheritingTypes: { [baseName: string]: string[] }, tc: ts.TypeChecker, private args = getDefaultArgs()) {
            this.allSymbols = allSymbols;
            this.inheritingTypes = inheritingTypes;
            this.tc = tc;
        }

        public get ReffedDefinitions(): { [key: string]: any } {
            return this.reffedDefinitions;
        }
        /**
         * (source: Typson)
         * Extracts the schema validation keywords stored in a comment and register them as properties.
         * A validation keyword starts by a @. It has a name and a value. Several keywords may occur.
         *
         * @param comment {string} the full comment.
         * @param to {object} the destination variable.
         */
        private copyValidationKeywords(comment: string, to) {
            JsonSchemaGenerator.annotedValidationKeywordPattern.lastIndex = 0;
            // TODO: to improve the use of the exec method: it could make the tokenization
            let annotation;
            while ((annotation = JsonSchemaGenerator.annotedValidationKeywordPattern.exec(comment))) {
                const annotationTokens = annotation[0].split(" ");
                let keyword: string = annotationTokens[0].slice(1);
                const path = keyword.split(".");
                let context = null;

                // TODO: paths etc. originate from Typson, not supported atm.
                if (path.length > 1) {
                    context = path[0];
                    keyword = path[1];
                }

                keyword = keyword.replace("TJS-", "");

                // case sensitive check inside the dictionary
                if (JsonSchemaGenerator.validationKeywords.indexOf(keyword) >= 0 || JsonSchemaGenerator.validationKeywords.indexOf("TJS-" + keyword) >= 0) {
                    let value: string = annotationTokens.length > 1 ? annotationTokens.slice(1).join(" ") : "";
                    value = value.replace(/^\s+|\s+$/gm, "");  // trim all whitepsace characters, including newlines
                    try {
                        value = JSON.parse(value);
                    } catch (e) { }
                    if (context) {
                        if (!to[context]) {
                            to[context] = {};
                        }
                        to[context][keyword] = value;
                    }
                    else {
                        to[keyword] = value;
                    }
                }
            }
        }

        /**
         * (source: Typson)
         * Extracts the description part of a comment and register it in the description property.
         * The description is supposed to start at first position and may be delimited by @.
         *
         * @param comment {string} the full comment.
         * @param to {object} the destination variable or definition.
         * @returns {string} the full comment minus the beginning description part.
         */
        private copyDescription(comment: string, to): string {
            const delimiter = "@";
            const delimiterIndex = comment.indexOf(delimiter);
            const description = comment.slice(0, delimiterIndex < 0 ? comment.length : delimiterIndex);
            if (description.length > 0) {
                to.description = description.replace(/\s+$/g, "");
            }
            return delimiterIndex < 0 ? "" : comment.slice(delimiterIndex);
        }

        private parseCommentsIntoDefinition(symbol: ts.Symbol, definition: any): void {
            if (!symbol) {
                return;
            }
            const comments : ts.SymbolDisplayPart[] = symbol.getDocumentationComment();
            if (!comments || !comments.length) {
                return;
            }
            let joined = comments.map(comment => comment.text.trim()).join("\n");
            joined = this.copyDescription(joined, definition);
            this.copyValidationKeywords(joined, definition);
        }
        
        private getDefinitionForRootType(propertyType: ts.Type, tc: ts.TypeChecker, reffedType: ts.Symbol, definition: any) {
            const symbol = propertyType.getSymbol();
            const propertyTypeString = tc.typeToString(propertyType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
            
            switch (propertyTypeString.toLowerCase()) {
                case "string":
                    definition.type = "string";
                    break;
                case "number":
                    const isInteger = (definition.type == "integer" || (reffedType && reffedType.getName() == "integer")); 
                    definition.type = isInteger ? "integer" : "number";
                    break;
                case "boolean":
                    definition.type = "boolean";
                    break;
                case "any":
                    // no type restriction, so that anything will match
                    break;
                case "date":
                    definition.type = "string";
                    definition.format = "date-time";
                    break;
                default:
                    if(propertyType.flags & ts.TypeFlags.Tuple) { // tuple
                        const tupleType: ts.TupleType = <ts.TupleType>propertyType;
                        const fixedTypes = tupleType.elementTypes.map(elType => this.getTypeDefinition(elType, tc));
                        definition.type = "array";
                        definition.items = fixedTypes;
                        definition.minItems = fixedTypes.length;
                        definition.additionalItems = {
                            "anyOf": fixedTypes
                        };
                    } else if (propertyType.flags & ts.TypeFlags.StringLiteral) {
                        definition.type = "string";
                        definition.enum = [ (<ts.StringLiteralType> propertyType).text ];
                    } else if (symbol && symbol.getName() == "Array") {
                        const arrayType = (<ts.TypeReference>propertyType).typeArguments[0];
                        definition.type = "array";
                        definition.items = this.getTypeDefinition(arrayType, tc);
                    } else {
                        
                        // TODO
                        console.error("Unsupported type: ", propertyType);
                        //definition = this.getTypeDefinition(propertyType, tc);
                    }
            }
            
            return definition;
        }
        
        private getReferencedTypeSymbol(prop: ts.Symbol, tc: ts.TypeChecker) : ts.Symbol {
            const decl = prop.getDeclarations();
            if (decl && decl.length) {
                const type = (<ts.TypeReferenceNode> (<any> decl[0]).type);
                if (type && (type.kind & ts.SyntaxKind.TypeReference) && type.typeName) {
                    return tc.getSymbolAtLocation(type.typeName);
                }
            }
            return null;
        }

        private getDefinitionForProperty(prop: ts.Symbol, tc: ts.TypeChecker, node: ts.Node) {
            const propertyName = prop.getName();
            const propertyType = tc.getTypeOfSymbolAtLocation(prop, node);
            const propertyTypeString = tc.typeToString(propertyType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);

            const reffedType = this.getReferencedTypeSymbol(prop, tc);
            
            let definition: any = this.getTypeDefinition(propertyType, tc, undefined, undefined, prop, reffedType);
            if (this.args.useTitle) {
                definition.title = propertyName;
            }

            if (definition.hasOwnProperty("ignore")) {
                return null;
            }

            // try to get default value
            let initial = (<ts.VariableDeclaration>prop.valueDeclaration).initializer;

            if (initial) {
                if ((<any>initial).expression) { // node
                    console.warn("initializer is expression for property " + propertyName);
                } else if ((<any>initial).kind && (<any>initial).kind == ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
                    definition.default = initial.getText();
                } else {
                    try {
                        const sandbox = { sandboxvar: null };
                        vm.runInNewContext("sandboxvar=" + initial.getText(), sandbox);

                        initial = sandbox.sandboxvar;
                        if (initial === null || typeof (initial) === "string" || typeof (initial) === "number" || typeof (initial) === "boolean" || Object.prototype.toString.call(initial) === '[object Array]') {
                            definition.default = initial;
                        } else if (initial) {
                            console.warn("unknown initializer for property " + propertyName + ": " + initial);
                        }
                    } catch (e) {
                        console.warn("exception evaluating initializer for property " + propertyName);
                    }
                }
            }

            return definition;
        }

        private getEnumDefinition(clazzType: ts.Type, tc: ts.TypeChecker, definition: any): any {
            const node = clazzType.getSymbol().getDeclarations()[0];
const fullName = tc.typeToString(clazzType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
            const enm = <ts.EnumDeclaration>node;
            const values = tc.getIndexTypeOfType(clazzType, ts.IndexKind.String);

            var enumValues: string[] = [];

            enm.members.forEach(member => {
                const caseLabel = (<ts.Identifier>member.name).text;

                // try to extract the enums value; it will probably by a cast expression
                let initial = <ts.Expression>member.initializer;

                if (initial) {
                    if ((<any>initial).expression) { // node
                        const exp = (<any>initial).expression;
                        const text = (<any>exp).text;
                        // if it is an expression with a text literal, chances are it is the enum convension:
                        // CASELABEL = 'literal' as any
                        if (text) {
                            enumValues.push(text);
                        } else {
                            console.warn("initializer is expression for enum: " + fullName + "." + caseLabel);
                        }
                    } else if ((<any>initial).kind && (<any>initial).kind == ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
                        enumValues.push(initial.getText());
                    }
                }
            });

            definition.type = "string";

            if (enumValues.length > 0) {
                definition["enum"] = enumValues;
            }

            return definition;
        }

        private getClassDefinition(clazzType: ts.Type, tc: ts.TypeChecker, definition: any): any {
            const node = clazzType.getSymbol().getDeclarations()[0];
            const clazz = <ts.ClassDeclaration>node;
            const props = tc.getPropertiesOfType(clazzType);
            const fullName = tc.typeToString(clazzType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);

            if(props.length == 0 && clazz.members && clazz.members.length == 1 && clazz.members[0].kind == ts.SyntaxKind.IndexSignature) {
                // for case "array-types"
                const indexSignature = <ts.IndexSignatureDeclaration>clazz.members[0];
                if(indexSignature.parameters.length != 1) {
                    throw "Not supported: IndexSignatureDeclaration parameters.length != 1"
                }
                const indexSymbol: ts.Symbol = (<any>indexSignature.parameters[0]).symbol;
                const indexType = tc.getTypeOfSymbolAtLocation(indexSymbol, node);
                const isStringIndexed = (indexType.flags == ts.TypeFlags.String);
                if(indexType.flags != ts.TypeFlags.Number && !isStringIndexed) {
                    throw "Not supported: IndexSignatureDeclaration with index symbol other than a number or a string";
                }
                
                const typ = tc.getTypeAtLocation(indexSignature.type);
                const def = this.getTypeDefinition(typ, tc, undefined, "anyOf");
                
                if(isStringIndexed) {
                    definition.type = "object";
                    definition.additionalProperties = def;
                } else {
                    definition.type = "array";
                    definition.items = def;
                }
                return definition;
            } else if (clazz.flags & ts.NodeFlags.Abstract) {
                const oneOf = this.inheritingTypes[fullName].map((typename) => {
                    return this.getTypeDefinition(this.allSymbols[typename], tc);
                });

                definition.oneOf = oneOf;

                return definition;
            } else {
                const propertyDefinitions = props.reduce((all, prop) => {
                    const propertyName = prop.getName();
                    const propDef = this.getDefinitionForProperty(prop, tc, node);
                    if (propDef != null) {
                        all[propertyName] = propDef;
                    }
                    return all;
                }, {});

                definition.type = "object";
                definition.properties = propertyDefinitions;

                if (this.args.useDefaultProperties) {
                    definition.defaultProperties = [];
                }
                if (this.args.disableExtraProperties && definition.additionalProperties === undefined) {
                    definition.additionalProperties = false;
                }
                if (this.args.usePropertyOrder) {
                    // propertyOrder is non-standard, but useful:
                    // https://github.com/json-schema/json-schema/issues/87
                    const propertyOrder = props.reduce((order, prop) => {
                        order.push(prop.getName());
                        return order;
                    }, []);

                    definition.propertyOrder = propertyOrder;
                }
                if (this.args.generateRequired) {
                    const requiredProps = props.reduce((required, prop) => {
                        if (!(prop.flags & ts.SymbolFlags.Optional)) {
                            required.push(prop.getName());
                        }
                        return required;
                    }, []);

                    if (requiredProps.length > 0) {
                        definition.required = requiredProps;
                    }
                }
            }
        }
        
        private getTypeDefinition(typ: ts.Type, tc: ts.TypeChecker, asRef = this.args.useRef, unionModifier: string = "oneOf", prop? : ts.Symbol, reffedType?: ts.Symbol): any {
            const definition : any = {}; // real definition
            let returnedDefinition = definition; // returned definition, may be a $ref
            
            const symbol = typ.getSymbol();
            
            const isRawType = (!symbol || symbol.name == "integer" || symbol.name == "Array" || symbol.name == "Date");
            
            // special case: an union where all child are string literals -> make an enum instead
            let isStringEnum = false;
            if (typ.flags & ts.TypeFlags.Union) {
                const unionType = <ts.UnionType>typ;
                isStringEnum = (unionType.types.every((propType, i, r) => {
                    return (propType.getFlags() & ts.TypeFlags.StringLiteral) != 0;
                }));
            }
            
            // aliased types must be handled slightly different
            const asTypeAliasRef = asRef && ((reffedType && this.args.useTypeAliasRef) || isStringEnum);
            if (!asTypeAliasRef) {
                if (isRawType || (typ.getFlags() & ts.TypeFlags.Anonymous)) {
                    asRef = false; // raw types and inline types cannot be reffed,
                                   // unless we are handling a type alias
                }
            }
          
            let fullTypeName = "";
            if (asTypeAliasRef) {
                fullTypeName = tc.getFullyQualifiedName(reffedType);
            } else if (asRef) {
                fullTypeName = tc.typeToString(typ, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
            }
            
            if (asRef) {
                returnedDefinition = {
                    "$ref":  "#/definitions/" + fullTypeName
                };
            }
            
            // Parse comments
            this.parseCommentsIntoDefinition(reffedType, definition); // handle comments in the type alias declaration
            this.parseCommentsIntoDefinition(prop || symbol, returnedDefinition);
            
            if (!asRef || !this.reffedDefinitions[fullTypeName]) {
                if (asRef) { // must be here to prevent recursivity problems
                    this.reffedDefinitions[fullTypeName] = definition;
                    if (this.args.useTitle && fullTypeName) {
                        definition.title = fullTypeName;
                    }
                }
                
                const node = symbol ? symbol.getDeclarations()[0] : null;
                if (typ.flags & ts.TypeFlags.Union) {
                    const unionType = <ts.UnionType>typ;
                    if (isStringEnum) {
                        definition.type = "string";
                        definition.enum = unionType.types.map((propType) => {
                            return (<ts.StringLiteralType> propType).text;
                        });
                    } else {
                        definition[unionModifier] = unionType.types.map((propType) => {
                            return this.getTypeDefinition(propType, tc);
                        });
                    }
                } else if (isRawType) {
                    this.getDefinitionForRootType(typ, tc, reffedType, definition);
                } else if (node.kind == ts.SyntaxKind.EnumDeclaration) {
                    this.getEnumDefinition(typ, tc, definition);
                } else {
                    this.getClassDefinition(typ, tc, definition);
                }
            }
            
            return returnedDefinition;
        }

        public getSchemaForSymbol(symbolName: string, includeReffedDefinitions: boolean = true): any {
            if(!this.allSymbols[symbolName]) {
                throw `type ${symbolName} not found`;
            }
            let def = this.getTypeDefinition(this.allSymbols[symbolName], this.tc, this.args.useRootRef);

            if (this.args.useRef && includeReffedDefinitions && Object.keys(this.reffedDefinitions).length > 0) {
                def.definitions = this.reffedDefinitions;
            }
            def["$schema"] = "http://json-schema.org/draft-04/schema#";
            //console.log(JSON.stringify(def, null, 4) + "\n");
            return def;
        }
    }

    export function getProgramFromFiles(files: string[]): ts.Program {  
        // use built-in default options
        const options: ts.CompilerOptions = { 
            noEmit: true, emitDecoratorMetadata: true, experimentalDecorators: true, target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS
        };
        return ts.createProgram(files, options); 
    }
    
    export function generateSchema(program: ts.Program, fullTypeName: string, args = getDefaultArgs()) {
        const tc = program.getTypeChecker();

        var diagnostics = ts.getPreEmitDiagnostics(program);

        if (diagnostics.length == 0) {

            const allSymbols: { [name: string]: ts.Type } = {};
            const inheritingTypes: { [baseName: string]: string[] } = {};

            program.getSourceFiles().forEach(sourceFile => {    
                /*console.log(sourceFile.fileName);    
                if(sourceFile.fileName.indexOf("main.ts") > -1) {
                    debugger;
                } */          
                function inspect(node: ts.Node, tc: ts.TypeChecker) {
                    
                    if (node.kind == ts.SyntaxKind.ClassDeclaration
                        || node.kind == ts.SyntaxKind.InterfaceDeclaration
                        || node.kind == ts.SyntaxKind.EnumDeclaration
                        || node.kind == ts.SyntaxKind.TypeAliasDeclaration
                        ) {
                        const nodeType = tc.getTypeAtLocation(node);
                        let fullName = tc.getFullyQualifiedName((<any>node).symbol)
                        
                        // remove file name
                        // TODO: we probably don't want this eventually, 
                        // as same types can occur in different files and will override eachother in allSymbols
                        // This means atm we can't generate all types in large programs.
                        fullName = fullName.replace(/".*"\./, "");
                        
                        
                        allSymbols[fullName] = nodeType;
                        
                        const baseTypes = nodeType.getBaseTypes() || [];
                        
                        baseTypes.forEach(baseType => {
                            var baseName = tc.typeToString(baseType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                            if (!inheritingTypes[baseName]) {
                                inheritingTypes[baseName] = [];
                            }
                            inheritingTypes[baseName].push(fullName);
                        });
                    } else {
                        ts.forEachChild(node, (node) => inspect(node, tc));
                    }
                }
                inspect(sourceFile, tc);
            });

            const generator = new JsonSchemaGenerator(allSymbols, inheritingTypes, tc, args);
            let definition = generator.getSchemaForSymbol(fullTypeName);
            
            return definition;
        } else {
          diagnostics.forEach((diagnostic) => {
              let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
              if(diagnostic.file) {
                let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                console.warn(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
              } else {
                  console.warn(message);
              }
          });
        }
    }

    export function programFromConfig(configFileName: string) {
        // basically a copy of https://github.com/Microsoft/TypeScript/blob/3663d400270ccae8b69cbeeded8ffdc8fa12d7ad/src/compiler/tsc.ts -> parseConfigFile
        const result = ts.parseConfigFileTextToJson(configFileName, ts.sys.readFile(configFileName));
        const configObject = result.config;
        
        const configParseResult = ts.parseJsonConfigFileContent(configObject, ts.sys, path.dirname(configFileName), {}, configFileName);
        const options = configParseResult.options;
        options.noEmit = true;
        delete options.out;
        delete options.outDir;
        delete options.outFile;
        delete options.declaration;
     
        const program = ts.createProgram(configParseResult.fileNames, options);
        return program;
        
        //const conf = ts.convertCompilerOptionsFromJson(null, path.dirname(filePattern), "tsconfig.json");
    }
    export function exec(filePattern: string, fullTypeName: string, args = getDefaultArgs()) {
        let program: ts.Program;
        if(path.basename(filePattern) == "tsconfig.json") {
            program = programFromConfig(filePattern);
        } else {
            program = TJS.getProgramFromFiles(glob.sync(filePattern));
        }
        
        const definition = TJS.generateSchema(program, fullTypeName, args);
        
        const json = JSON.stringify(definition, null, 4) + "\n";
        if(args.out) {
            require("fs").writeFile(args.out, json, function(err) {
                if(err) {
                    console.error("Unable to write output file: " + err.message);
                }
            }); 
        } else {
            process.stdout.write(json);
        }
    }

    export function run() {
        var helpText = "Usage: node typescript-json-schema.js <path-to-typescript-files-or-tsconfig> <type>";
        const defaultArgs = getDefaultArgs();
        var args = require("yargs")
            .usage(helpText)
            .demand(2)
            .boolean("refs").default("refs", defaultArgs.useRef)
                .describe("refs", "Create shared ref definitions.")
            .boolean("aliasRefs").default("aliasRefs", defaultArgs.useTypeAliasRef)
                .describe("aliasRefs", "Create shared ref definitions for the type aliases.")
            .boolean("topRef").default("topRef", defaultArgs.useRootRef)
                .describe("topRef", "Create a top-level ref definition.")
            .boolean("titles").default("titles", defaultArgs.useTitle)
                .describe("titles", "Creates titles in the output schema.")
            .boolean("defaultProps").default("defaultProps", defaultArgs.useDefaultProperties)
                .describe("defaultProps", "Create default properties definitions.")
            .boolean("noExtraProps").default("noExtraProps", defaultArgs.disableExtraProperties)
                .describe("noExtraProps", "Disable additional properties in objects by default.")
            .boolean("propOrder").default("propOrder", defaultArgs.usePropertyOrder)
                .describe("propOrder", "Create property order definitions.")
            .boolean("required").default("required", defaultArgs.generateRequired)
                .describe("required", "Create required array for non-optional properties.")
            .alias("out", "o")
                .describe("out", "The output file, defaults to using stdout")
            .argv;

        exec(args._[0], args._[1], {
            useRef: args.refs,
            useTypeAliasRef: args.aliasRefs,
            useRootRef: args.topRef,
            useTitle: args.titles,
            useDefaultProperties: args.defaultProps,
            disableExtraProperties: args.noExtraProps,
            usePropertyOrder: args.propOrder,
            generateRequired: args.required,
            out: args.out
        });
    }
}

if (typeof window === "undefined" && require.main === module) {
    TJS.run();
}

//TJS.exec("example/**/*.ts", "Invoice");
/*
let args = TJS.defaultArgs;
args.useRootRef = true;
const result = TJS.generateSchema(TJS.getProgramFromFiles(["test/programs/interface-recursion/main.ts"]), "MyObject", args);
console.log(JSON.stringify(result));
*/