require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Client } = require('pg');

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const recent = await c.query(`
    select pe.id, pe.search_execution_id, pe.status, pe.current_stage, pe.error_code,
           left(coalesce(pe.error_message,''), 200) as error_message,
           pe.created_at, pe.completed_at,
           se.user_prompt, se.status as exec_status,
           left(coalesce(se.structured_plan::text,''), 800) as plan_snip
    from pipeline_executions pe
    left join search_executions se on se.id = pe.search_execution_id
    where pe.created_at > now() - interval '2 days'
    order by pe.created_at desc
    limit 8
  `);
  for (const row of recent.rows) {
    console.log('---');
    console.log(JSON.stringify({
      pipeline: row.id,
      execution: row.search_execution_id,
      status: row.status,
      stage: row.current_stage,
      error: row.error_code,
      created: row.created_at,
      prompt: row.user_prompt,
      plan: row.plan_snip,
    }, null, 2));
  }
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
