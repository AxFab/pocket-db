# Roadmap Réaliste

## V0 : prototype mémoire + persistance append-only.

collections ; OK
documents JSON ; OK
_id automatique ; OK
insert/find by id ; OK
insertOne, insertMany ; OK
scan complet ; OK
format record robuste ; OK
tests de crash partiel ; OK

## V1 : vraie petite base utilisable.

findOne({ field: value }) ; OK
findOne, find, limit ; OK
updateOne avec $set, $unset... ; OK
deleteOne, deleteMany ; OK
index simple ; OK
update/delete ; OK
compaction manuelle ; OK
TypeScript API propre ;
benchmarks contre JSON stringify complet ; OK

## V2 : performance et robustesse.

find sort limité ;
index unique ;
mode durability strict/relaxed ;
compaction automatique ;
meilleur query planner ;
index persistés ;
snapshots de lecture ;
batching ;
scan streaming ;

## V3 : fonctionnalités avancées choisies.

index composés ;
transactions légères ;
compression ;
lock multi-process ;
moteur natif optionnel ;

## Additional

on Collection count(query), distinct(field, query) ;
hideIndex(name)  getIndex() ;
stats() ;
read file using page cache ;
stats() give { liveSlots, totalSlots, ratioSlots (= (total - live / total)), collections: [ { name, documents: #count, indexes: [{ name type }] } ] }
