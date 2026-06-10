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

- durability mode strict/relaxed ;
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
- stats() ;
- binary serialization for faster parsing ;
- use file page cache to improve read ops ;
- read file using page cache ;
- stats() give
```
{
  liveSlots: 0,
  totalSlots: 0,
  ratioSlots: 0, // (= (total - live / total)),
  collections: [
    {
      name: '',
      documents: #count,
      indexes: [
        { name: '', type: '' }
      ]
    }
  ]
}
```

## Update operator

https://www.mongodb.com/docs/manual/reference/mql/update/#std-label-update-operators

 - `$currentDate`. Sets the value of a field to current date. We need an options to know the format
 - `$mul`. Multiplies the value of the field by the specified amount.
 - `$rename` Renames a field.

 - `$addToSet` Adds elements to an array only if they do not already exist in the set.
 - `$pop` Removes the first or last item of an array.
 - `$pull/pullAll` Removes all array elements that match a specified query.
 - `$regex` Regexp `str.test(regex)` (don't allow /g or /y)

## Sorting

https://www.mongodb.com/docs/manual/reference/method/cursor.sort/


## Predicate clause

https://www.mongodb.com/docs/manual/reference/mql/query-predicates/

- `$type` Matches documents if a field is of the specified type.
- `$regex` Matches documents where values match a specified regular expression.
