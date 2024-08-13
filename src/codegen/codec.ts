import { generateField, getFieldName } from "./field.ts";
import type { TypeSchema } from "./schema.ts";
import {
  areAllScalarTypes,
  getAllProperties,
  getDecoder,
  getDecoders,
  getEncoders,
  getSubtypes,
  isCompactableType,
} from "./type.ts";

export async function* generateEncoder(
  typeUri: string,
  types: Record<string, TypeSchema>,
): AsyncIterable<string> {
  const type = types[typeUri];
  yield `
  /**
   * Converts this object to a JSON-LD structure.
   * @param options The options to use.
   *                - \`format\`: The format of the output: \`compact\` or
                      \`expand\`.
   *                - \`contextLoader\`: The loader for remote JSON-LD contexts.
   *                - \`context\`: The JSON-LD context to use.  Not applicable
                      when \`format\` is set to \`'expand'\`.
   * @returns The JSON-LD representation of this object.
   */
  async toJsonLd(options: {
    format?: "compact" | "expand",
    expand?: boolean,
    contextLoader?: DocumentLoader,
    context?: string | Record<string, string> | (string | Record<string, string>)[],
  } = {}): Promise<unknown> {
    if (options.expand != null) {
      if (options.format != null) {
        throw new TypeError(
          "The expand option, which is deprecated, cannot be used together " +
          "with the format option."
        );
      }
      getLogger(["fedify", "vocab"]).warn(
        "The expand option is deprecated; use format: 'expand' instead.",
      );
      options = { ...options, format: "expand", expand: undefined };
    }
    if (options.format == null && this.#cachedJsonLd != null) {
      return this.#cachedJsonLd;
    }
    if (options.format !== "compact" && options.context != null) {
      throw new TypeError(
        "The context option can only be used when the format option is set " +
        "to 'compact'."
      );
    }
    options = {
      ...options,
      contextLoader: options.contextLoader ?? fetchDocumentLoader,
    };
  `;
  if (isCompactableType(typeUri, types)) {
    yield `
    if (
      options.format == null
    `;
    for (const property of type.properties) {
      if (!property.range.every((r) => isCompactableType(r, types))) {
        yield `
        && (
          this.${await getFieldName(property.uri)} == null ||
          this.${await getFieldName(property.uri)}.length < 1
        )
        `;
      }
    }
    yield `
    ) {
    `;
    if (type.extends == null) {
      yield "const result: Record<string, unknown> = {};";
    } else {
      yield `
      const result = await super.toJsonLd({
        ...options,
        format: undefined,
        context: undefined,
      }) as Record<string, unknown>;
      `;
      const selfProperties = type.properties.map((p) => p.uri);
      for (const property of getAllProperties(typeUri, types, true)) {
        if (!selfProperties.includes(property.uri)) continue;
        yield `delete result[${JSON.stringify(property.compactName)}];`;
      }
    }
    yield `
      // deno-lint-ignore no-unused-vars
      let compactItems: unknown[];
    `;
    for (const property of type.properties) {
      yield `
      compactItems = [];
      for (const v of this.${await getFieldName(property.uri)}) {
        const item = (
      `;
      if (!areAllScalarTypes(property.range, types)) {
        yield "v instanceof URL ? v.href : ";
      }
      const encoders = getEncoders(
        property.range,
        types,
        "v",
        "options",
        true,
      );
      for (const code of encoders) yield code;
      yield `
        );
        compactItems.push(item);
      }
      `;
      if (property.functional || property.container !== "list") {
        yield `
        if (compactItems.length > 1) {
          result[${JSON.stringify(property.compactName)}] = compactItems;
        } else if (compactItems.length === 1) {
          result[${JSON.stringify(property.compactName)}] = compactItems[0];
        }
        `;
      } else {
        yield `
        if (compactItems.length > 0) {
          result[${JSON.stringify(property.compactName)}] = compactItems;
        }
        `;
      }
    }
    yield `
      result["type"] = ${JSON.stringify(type.compactName ?? type.uri)};
      if (this.id != null) result["id"] = this.id.href;
      result["@context"] = ${JSON.stringify(type.defaultContext)};
      return result;
    }
    `;
  }
  yield `
    // deno-lint-ignore no-unused-vars prefer-const
    let array: unknown[];
  `;
  if (type.extends == null) {
    yield "const values: Record<string, unknown[] | string> = {};";
  } else {
    yield `
    const baseValues = await super.toJsonLd({
      ...options,
      format: "expand",
      context: undefined,
    }) as unknown[];
    const values = baseValues[0] as Record<
      string,
      unknown[] | { "@list": unknown[] } | string
    >;
    `;
  }
  for (const property of type.properties) {
    yield `
    array = [];
    for (const v of this.${await getFieldName(property.uri)}) {
      const element = (
    `;
    if (!areAllScalarTypes(property.range, types)) {
      yield 'v instanceof URL ? { "@id": v.href } : ';
    }
    for (const code of getEncoders(property.range, types, "v", "options")) {
      yield code;
    }
    yield `
      );
    `;
    if (!property.functional && property.container === "graph") {
      yield `array.push({ "@graph": element });`;
    } else {
      yield `array.push(element);`;
    }
    yield `;
    }
    if (array.length > 0) {
      values[${JSON.stringify(property.uri)}] = (
    `;
    if (!property.functional && property.container === "list") {
      yield `{ "@list": array }`;
    } else {
      yield `array`;
    }
    yield `
      );
    }
    `;
  }
  yield `
    values["@type"] = [${JSON.stringify(type.uri)}];
    if (this.id != null) values["@id"] = this.id.href;
    if (options.format === "expand") {
      return await jsonld.expand(
        values,
        { documentLoader: options.contextLoader },
      );
    }
    const docContext = options.context ??
      ${JSON.stringify(type.defaultContext)};
    const compacted = await jsonld.compact(
      values,
      docContext,
      { documentLoader: options.contextLoader },
    );
    if (docContext != null) {
      // Embed context
  `;
  const supertypes: string[] = [];
  for (
    let uri: string | undefined = typeUri;
    uri != null;
    uri = types[uri].extends
  ) {
    supertypes.push(uri);
  }
  for (const supertype of supertypes) {
    for (const property of types[supertype].properties) {
      if (property.embedContext == null) continue;
      const compactName = property.embedContext.compactName;
      yield `
      if (${JSON.stringify(compactName)} in compacted &&
          compacted.${compactName} != null) {
        if (Array.isArray(compacted.${compactName})) {
          for (const element of compacted.${compactName}) {
            element["@context"] = docContext;
          }
        } else {
         compacted.${compactName}["@context"] = docContext;
        }
      }
      `;
    }
  }
  yield `
    }
    return compacted;
  }
  `;
}

export async function* generateDecoder(
  typeUri: string,
  types: Record<string, TypeSchema>,
): AsyncIterable<string> {
  const type = types[typeUri];
  yield `
  /**
   * Converts a JSON-LD structure to an object of this type.
   * @param json The JSON-LD structure to convert.
   * @returns The object of this type.
   * @throws {TypeError} If the given \`json\` is invalid.
   */
  static async fromJsonLd(
    json: unknown,
    options: {
      documentLoader?: DocumentLoader,
      contextLoader?: DocumentLoader,
    } = {},
  ): Promise<${type.name}> {
    if (typeof json === "undefined") {
      throw new TypeError("Invalid JSON-LD: undefined.");
    }
    else if (json === null) throw new TypeError("Invalid JSON-LD: null.");
    options = {
      ...options,
      documentLoader: options.documentLoader ?? fetchDocumentLoader,
      contextLoader: options.contextLoader ?? fetchDocumentLoader,
    };
    // deno-lint-ignore no-explicit-any
    let values: Record<string, any[]> & { "@id"?: string };
    if (globalThis.Object.keys(json).length == 0) {
      values = {};
    } else {
      const expanded = await jsonld.expand(json, {
        documentLoader: options.contextLoader,
        keepFreeFloatingNodes: true,
      });
      values =
        // deno-lint-ignore no-explicit-any
        (expanded[0] ?? {}) as (Record<string, any[]> & { "@id"?: string });
    }
  `;
  const subtypes = getSubtypes(typeUri, types, true);
  yield 'if ("@type" in values) {\n';
  for (const subtypeUri of subtypes) {
    yield `
    if (values["@type"].includes(${JSON.stringify(subtypeUri)})) {
      return await ${types[subtypeUri].name}.fromJsonLd(json, options);
    }
    `;
  }
  yield `
    if (!values["@type"].includes(${JSON.stringify(typeUri)})) {
      throw new TypeError("Invalid type: " + values["@type"]);
    }
  }
  `;
  if (type.extends == null) {
    yield `
    const instance = new this(
      { id: "@id" in values ? new URL(values["@id"] as string) : undefined },
      options,
    );
    `;
  } else {
    yield `
    delete values["@type"];
    const instance = await super.fromJsonLd(values, {
      ...options,
      // @ts-ignore: an internal option
      _fromSubclass: true,
    });
    if (!(instance instanceof ${type.name})) {
      throw new TypeError("Unexpected type: " + instance.constructor.name);
    }
    `;
  }
  for (const property of type.properties) {
    const variable = await getFieldName(property.uri, "");
    yield await generateField(property, types, "const ");
    const arrayVariable = `${variable}__array`;
    yield `
    const ${arrayVariable} = values[${JSON.stringify(property.uri)}];
    for (
      const v of ${arrayVariable} == null
        ? []
        : ${arrayVariable}.length === 1 && "@list" in ${arrayVariable}[0]
        ? ${arrayVariable}[0]["@list"]
        : ${arrayVariable}
    ) {
      if (v == null) continue;
    `;
    if (!areAllScalarTypes(property.range, types)) {
      yield `
      if (typeof v === "object" && "@id" in v && !("@type" in v)
          && globalThis.Object.keys(v).length === 1) {
        ${variable}.push(new URL(v["@id"]));
        continue;
      }
      `;
    }
    if (property.range.length == 1) {
      yield `${variable}.push(${
        getDecoder(property.range[0], types, "v", "options")
      })`;
    } else {
      yield `
      const decoded =
      `;
      for (const code of getDecoders(property.range, types, "v", "options")) {
        yield code;
      }
      yield `
      ;
      if (typeof decoded === "undefined") continue;
      ${variable}.push(decoded);
      `;
    }
    yield `
    }
    instance.${await getFieldName(property.uri)} = ${variable};
    `;
  }
  yield `
    if (!("_fromSubclass" in options) || !options._fromSubclass) {
      try {
        instance.#cachedJsonLd = structuredClone(json);
      } catch {
        getLogger(["fedify", "vocab"]).warn(
          "Failed to cache JSON-LD: {json}",
          { json },
        );
      }
    }
    return instance;
  }
  `;
}
