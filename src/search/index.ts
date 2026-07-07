export { compileQuery } from "./compile-query.js";
export { evaluateCompiledQuery, matchesQuery, valuesEqual } from "./evaluate-query.js";
export { compareDocuments, parseSortSpec, MAX_SORT_FIELDS } from "./sort.js";
export { updateDocument } from "./update-document.js";
export type { CompiledQuery, CurrentDateSpec, DocumentRecord, DocumentValue, FieldOperator, FieldPredicate, PullCondition, Query, UpdateExpression } from "./types.js";
export type { SortDirection, SortField } from "./sort.js";
