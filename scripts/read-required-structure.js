import readXlsxFile from 'read-excel-file/node'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const xlsxPath = path.join(__dirname, '..', '..', 'Sousannah-Discovery-AI-Required-Data-Structure 1.xlsx')
readXlsxFile(xlsxPath).then(rows => {
  console.log('=== HEADERS (Row 0) ===')
  console.log(JSON.stringify(rows[0], null, 2))
  console.log('\n=== ROW 1 (sample) ===')
  if (rows[1]) console.log(JSON.stringify(rows[1], null, 2))
  console.log('\n=== COLUMN NAMES (one per line) ===')
  rows[0].forEach((h, i) => console.log(`${i + 1}. ${h}`))
}).catch(e => console.error(e))
