export { compileQuery } from "./compile-query.js";
export { evaluateCompiledQuery, matchesQuery } from "./evaluate-query.js";
export { compareDocuments, parseSortSpec, MAX_SORT_FIELDS } from "./sort.js";
export { updateDocument } from "./update-document.js";
export type { CompiledQuery, DocumentRecord, FieldOperator, FieldPredicate, Query, UpdateExpression } from "./types.js";
export type { SortDirection, SortField } from "./sort.js";
