# Roadmap

## V0 : append-only persistance.

- collections ; OK
- JSON documents ; OK
- _id automatic ; OK
- insert/find by id ; OK
- insertOne, insertMany ; OK
- full scan ; OK
- robust record format (crc) ; OK
- testing partial crash ; OK

## V1 : real and usable little database.

- findOne({ field: value }) ; OK
- findOne, find, limit ; OK
- updateOne with $set, $unset... ; OK
- deleteOne, deleteMany ; OK
- simple index ; OK
- update/delete ; OK
- manual compaction ; OK
- TypeScript API cleanup ; OK
- benchmarks ; OK
- find with limited sort ; OK

## V2 : performance and robustness.

- durability mode strict/relaxed ; OK
- automatic compaction ;
- uniq index ;
- query planner improvment ;
- persisted index ;
- reading snapshots ;
- batching ;
- scan streaming ;

## V3 : advanced features.

- composed index ;
- light transactions ;
- compression ;
- lock multi-process ;
- native engine optionnel ;

## additional

- on Collection distinct(field, query) ;
- hideIndex(name)  getIndex() ;
- stats() ; OK
- binary serialization for faster parsing ; TRIED
- read file using page cache ;

## Update operator

https://www.mongodb.com/docs/manual/reference/mql/update/#std-label-update-operators

## Sorting

https://www.mongodb.com/docs/manual/reference/method/cursor.sort/

## Predicate clause

https://www.mongodb.com/docs/manual/reference/mql/query-predicates/
