import { randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { sql } from 'remix/data-table'
import { collectShiftSheetSourceFileKeys, createDataRuntime, findUnreferencedShiftSheetSourceFileKeys } from '../../app/data/index.ts'

describe('handover sheet storage lifecycle', () => {
  it('collects distinct authorized keys and only releases keys with no remaining references', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), user = randomUUID(), firstShift = randomUUID(), secondShift = randomUUID()
    let shared = `${randomUUID()}.csv`, exclusive = `${randomUUID()}.csv`
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${user},'Storage Test','Nurse','Ward')`)
      for (let shift of [firstShift, secondShift]) await runtime.db.exec(sql`insert into shifts(id,created_by_user_id,title,department) values(${shift},${user},${shift},'Ward')`)
      await runtime.db.exec(sql`
        insert into shift_sheet_patients(id,shift_id,patient_key,display_name,location,fields,source_file_name,source_file_key,extraction_method,row_index,imported_at,updated_at)
        values
          (${randomUUID()},${firstShift},'a','A','1','[]'::jsonb,'a.csv',${shared},'text',0,now(),now()),
          (${randomUUID()},${firstShift},'b','B','2','[]'::jsonb,'b.csv',${exclusive},'text',1,now(),now()),
          (${randomUUID()},${secondShift},'c','C','3','[]'::jsonb,'c.csv',${shared},'text',0,now(),now())
      `)
      let collected = await collectShiftSheetSourceFileKeys(runtime.db, { shiftId: firstShift, userId: user })
      assert.deepEqual(new Set(collected ?? []), new Set([shared, exclusive]))
      await runtime.db.exec(sql`delete from shift_sheet_patients where shift_id=${firstShift}`)
      assert.deepEqual(await findUnreferencedShiftSheetSourceFileKeys(runtime.db, collected ?? []), [exclusive])
      await runtime.db.exec(sql`delete from shift_sheet_patients where shift_id=${secondShift}`)
      assert.deepEqual(new Set(await findUnreferencedShiftSheetSourceFileKeys(runtime.db, collected ?? [])), new Set([shared, exclusive]))
    } finally {
      await runtime.db.exec(sql`delete from shifts where id in (${firstShift},${secondShift})`)
      await runtime.db.exec(sql`delete from users where id=${user}`)
      await runtime.close()
    }
  })

  it('does not disclose keys from inaccessible shifts', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), owner = randomUUID(), outsider = randomUUID(), shift = randomUUID()
    try {
      for (let user of [owner, outsider]) await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${user},${user},'Nurse','Ward')`)
      await runtime.db.exec(sql`insert into shifts(id,created_by_user_id,title,department) values(${shift},${owner},'Private','Ward')`)
      assert.equal(await collectShiftSheetSourceFileKeys(runtime.db, { shiftId: shift, userId: outsider }), null)
    } finally {
      await runtime.db.exec(sql`delete from shifts where id=${shift}`)
      await runtime.db.exec(sql`delete from users where id in (${owner},${outsider})`)
      await runtime.close()
    }
  })
})
