// functions/api.js (클라우드플레어 서버리스 API 역할)
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // GET 요청 (데이터 불러오기)
  if (request.method === 'GET') {
    if (action === 'getAll') {
      const products = await env.DB.prepare("SELECT * FROM products").all();
      const vendors = await env.DB.prepare("SELECT * FROM vendors").all();
      const suppliers = await env.DB.prepare("SELECT * FROM suppliers").all();
      const managers = await env.DB.prepare("SELECT * FROM managers").all();
      const pins = await env.DB.prepare("SELECT * FROM pins").all();
      const entries = await env.DB.prepare("SELECT * FROM entries ORDER BY id DESC").all();
      
      return new Response(JSON.stringify({
        products: products.results, vendors: vendors.results,
        suppliers: suppliers.results, managers: managers.results,
        pins: pins.results, entries: entries.results
      }), { headers: { 'Content-Type': 'application/json' }});
    }
  }

  // POST 요청 (데이터 저장, 수정, 삭제, 기초데이터 덮어쓰기)
  if (request.method === 'POST') {
    const data = await request.json();

    try {
      if (action === 'addEntry') {
        const stmt = env.DB.prepare(`
          INSERT INTO entries (id, del, check_status, recv, pCode, pName, pSpec, qty, vCode, vName, center, reg, regReason, date, supplierName, managerName, comp, compReasonSel, compReasonTxt)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
        `).bind(
          data.id, data.del ? 1 : 0, data.check ? 1 : 0, data.recv ? 1 : 0, data.pCode, data.pName, data.pSpec, data.qty,
          data.vCode, data.vName, data.center, data.reg, data.regReason, data.dateStr, data.supplierName, data.managerName, data.comp, data.compReasonSel, data.compReasonTxt
        );
        await stmt.run();
        return new Response('ok');
      }

      if (action === 'updateEntry') {
        let updateQuery = "UPDATE entries SET ";
        let binds = [];
        let index = 1;
        for (let key in data.updates) {
           updateQuery += `${key === 'check' ? 'check_status' : key} = ?${index}, `;
           binds.push(typeof data.updates[key] === 'boolean' ? (data.updates[key] ? 1 : 0) : data.updates[key]);
           index++;
        }
        updateQuery = updateQuery.slice(0, -2) + ` WHERE id = ?${index}`;
        binds.push(data.id);
        
        await env.DB.prepare(updateQuery).bind(...binds).run();
        return new Response('ok');
      }

      if (action === 'addPin') {
        await env.DB.prepare("INSERT OR REPLACE INTO pins (pin, name, approved) VALUES (?1, ?2, ?3)").bind(data.pin, data.name, data.approved ? 1 : 0).run();
        return new Response('ok');
      }
      
      if (action === 'deletePin') {
        await env.DB.prepare("DELETE FROM pins WHERE pin = ?1").bind(data.pin).run();
        return new Response('ok');
      }

      // 기초데이터 엑셀 업로드 (기존 데이터 삭제 후 일괄 인서트)
      if (action === 'uploadMaster') {
        await env.DB.prepare(`DELETE FROM ${data.table}`).run();
        
        if(data.rows && data.rows.length > 0) {
          // 간략화를 위해 하나씩 넣습니다. (성능 최적화는 추후 배치 처리 가능)
          for(let r of data.rows) {
            if(data.table === 'products') await env.DB.prepare("INSERT INTO products (code, name, spec, seller) VALUES (?1, ?2, ?3, ?4)").bind(r.code, r.name, r.spec, r.seller).run();
            if(data.table === 'vendors') await env.DB.prepare("INSERT INTO vendors (code, name, region, address, center) VALUES (?1, ?2, ?3, ?4, ?5)").bind(r.code, r.name, r.region, r.address, r.center).run();
            if(data.table === 'suppliers') await env.DB.prepare("INSERT INTO suppliers (code, name) VALUES (?1, ?2)").bind(r.code, r.name).run();
            if(data.table === 'managers') await env.DB.prepare("INSERT INTO managers (code, name) VALUES (?1, ?2)").bind(r.code, r.name).run();
          }
        }
        return new Response('ok');
      }

      if (action === 'clearAllEntries') {
        await env.DB.prepare("DELETE FROM entries").run();
        return new Response('ok');
      }

      if (action === 'clearAllPins') {
        await env.DB.prepare("DELETE FROM pins").run();
        return new Response('ok');
      }

    } catch(err) {
      return new Response(err.message, { status: 500 });
    }
  }
  
  return new Response('Not Found', { status: 404 });
}
