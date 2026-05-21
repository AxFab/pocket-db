export type DocumentValue =
  | null
  | boolean
  | number
  | string
  | DocumentValue[]
  | { [key: string]: DocumentValue };

export type DocumentRecord = Record<string, DocumentValue | undefined>;

export type QueryValue = DocumentValue | undefined;

/**
 * Operator expression used inside a field condition.
 * `$not` accepts the same operators (except a nested `$not`).
 */
export type FieldOperatorMap = {
  $eq?: QueryValue;
  $ne?: QueryValue;
  $gt?: QueryValue;
  $gte?: QueryValue;
  $lt?: QueryValue;
  $lte?: QueryValue;
  $in?: QueryValue[];
  $nin?: QueryValue[];
  $exists?: boolean;
  /** Negates the combined result of the enclosed operator expression. */
  $not?: Omit<FieldOperatorMap, "$not">;
};

export type FieldQuery = QueryValue | FieldOperatorMap;

export type Query = {
  $and?: Query[];
  $or?: Query[];
  $nor?: Query[];
} & {
  [field: string]: FieldQuery | Query[] | undefined;
};

export type CompiledQuery = AndPredicate | OrPredicate | NorPredicate | FieldPredicate;

export interface AndPredicate {
  type: "and";
  predicates: CompiledQuery[];
}

export interface OrPredicate {
  type: "or";
  predicates: CompiledQuery[];
}

export interface NorPredicate {
  type: "nor";
  predicates: CompiledQuery[];
}

export interface FieldPredicate {
  type: "field";
  field: string;
  operators: FieldOperator[];
}

export type FieldOperator =
  | { type: "eq";     value: QueryValue }
  | { type: "ne";     value: QueryValue }
  | { type: "gt";     value: QueryValue }
  | { type: "gte";    value: QueryValue }
  | { type: "lt";     value: QueryValue }
  | { type: "lte";    value: QueryValue }
  | { type: "in";     values: QueryValue[] }
  | { type: "nin";    values: QueryValue[] }
  | { type: "exists"; value: boolean }
  | { type: "not";    operators: FieldOperator[] };

export type UpdateExpression = {
  $set?: Record<string, DocumentValue>;
  $unset?: Record<string, unknown>;
  $min?: Record<string, number>;
  $max?: Record<string, number>;
  $inc?: Record<string, number>;
  $push?: Record<string, DocumentValue>;
}  & Record<string, unknown>;
