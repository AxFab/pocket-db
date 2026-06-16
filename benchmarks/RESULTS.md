# Benchmark results

- **Dataset:** 1,000 documents
- **Runtime:** Node.js v24.11.0
- **Generated:** 2026-06-16

All values in operations per second; higher is better. **Bold** = fastest adapter for that operation.

| Operation | pocket-db (strict-json) | pocket-db (relaxed-json) | pocket-db (relaxed-json-cache) | pocket-db (relaxed-bson) | pocket-db (relaxed-amf3) | sqlite (memory) | sqlite (file) | json-file | lowdb | lokijs |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| insertOne | 337 | 242,170 | **245,389** | 201,231 | 215,901 | 199,511 | 3,516 | 4,318 | 2,461 | 1,088 |
| insertMany (100) | 3 | **2,531** | 2,369 | 2,092 | 2,226 | 2,503 | 754 | 1,049 | 807 | 270 |
| findById | 44,120 | 188,602 | 546,884 | 187,468 | 183,801 | 957,472 | 237,440 | **11,747,430** | 307,787 | 3,724,395 |
| findByIdHot (16) | 130,580 | 254,033 | 467,690 | 217,197 | 216,843 | 1,057,688 | 248,637 | **21,731,288** | 11,441,648 | 7,517,384 |
| findAll | 93 | 92 | 119 | 67 | 66 | 350 | 353 | 117,062 | **920,251** | 1,117 |
| findByName (scan) | 89 | 90 | 139 | 67 | 65 | 505 | 524 | 19,546 | **24,002** | 7,797 |
| findByNameRegex (scan) | 88 | 89 | 142 | 66 | 65 | 323 | 324 | 7,883 | **8,474** | 3,616 |
| findByRole (index) | 258 | 256 | 390 | 191 | 188 | 864 | 873 | 18,013 | **21,974** | 3,148 |
| updateOne | 334 | 107,811 | 138,728 | 97,030 | 98,275 | **373,983** | 4,214 | 877 | 625 | 190 |
| deleteOne | 399 | 375,117 | 465,990 | **529,178** | 524,476 | 415,465 | 4,486 | 937 | 704 | 224 |
| countAll | 11,721 | 8,925 | 9,859 | 11,423 | 13,203 | 2,151,579 | 278,318 | 39,551,643 | **41,710,115** | 34,894,027 |
| sortByScore (desc) | 87 | 86 | 137 | 64 | 60 | 288 | 294 | 4,883 | **5,053** | 1,107 |

