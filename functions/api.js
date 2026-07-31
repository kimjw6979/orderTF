// Cloudflare Pages Functions 백엔드 API (D1 연동)

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // CORS 및 JSON 헤더 설정
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8"
    };

    // Preflight 요청 처리
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // DB 연결 확인 (Pages bindings에 지정된 D1 데이터베이스 이름 사용, 기본값 env.DB)
        const db = env.DB;
        if (!db) {
            return new Response(
                JSON.stringify({ error: "D1 데이터베이스 바인딩(DB)을 찾을 수 없습니다." }), 
                { status: 500, headers: corsHeaders }
            );
        }

        // =========================================================================
        // 1. 전체 데이터 및 업로드 일시 조회 (getAll)
        // =========================================================================
        if (action === "getAll") {
            // 각 테이블 데이터 병렬 조회
            const [entries, products, vendors, suppliers, managers, pins, metadata] = await Promise.all([
                db.prepare("SELECT * FROM entries ORDER BY id DESC").all(),
                db.prepare("SELECT * FROM products").all(),
                db.prepare("SELECT * FROM vendors").all(),
                db.prepare("SELECT * FROM suppliers").all(),
                db.prepare("SELECT * FROM managers").all(),
                db.prepare("SELECT * FROM pins").all(),
                // 🌟 업로드 일시 metadata 테이블 조회 (없으면 예외 방지용 catch 처리)
                db.prepare("SELECT * FROM upload_metadata").all().catch(() => ({ results: [] }))
            ]);

            // upload_metadata 결과를 { products: "2026-07-31 09:36", ... } 형태의 객체로 변환
            const uploadDatesMap = {};
            if (metadata && metadata.results) {
                metadata.results.forEach(row => {
                    uploadDatesMap[row.table_name] = row.last_upload_date;
                });
            }

            return new Response(JSON.stringify({
                entries: entries.results || [],
                products: products.results || [],
                vendors: vendors.results || [],
                suppliers: suppliers.results || [],
                managers: managers.results || [],
                pins: pins.results || [],
                uploadDates: uploadDatesMap // 👈 프론트엔드로 전달되는 업로드 일시 객체
            }), { headers: corsHeaders });
        }

        // =========================================================================
        // 2. 기초데이터 엑셀 업로드 (uploadMaster)
        // =========================================================================
        if (action === "uploadMaster" && request.method === "POST") {
            const { table, rows, uploadDate } = await request.json();

            if (!table || !Array.isArray(rows)) {
                return new Response(
                    JSON.stringify({ error: "잘못된 요청 형식입니다." }), 
                    { status: 400, headers: corsHeaders }
                );
            }

            // A. 기존 테이블 데이터 삭제 (덮어쓰기)
            await db.prepare(`DELETE FROM ${table}`).run();

            // B. 신규 데이터 대량 삽입 (Batch Insert)
            if (rows.length > 0) {
                let statements = [];

                if (table === "products") {
                    statements = rows.map(r => 
                        db.prepare("INSERT INTO products (code, name, spec, seller) VALUES (?, ?, ?, ?)")
                          .bind(r.code, r.name, r.spec, r.seller)
                    );
                } else if (table === "vendors") {
                    statements = rows.map(r => 
                        db.prepare("INSERT INTO vendors (code, name, region, address, center) VALUES (?, ?, ?, ?, ?)")
                          .bind(r.code, r.name, r.region, r.address, r.center)
                    );
                } else if (table === "suppliers") {
                    statements = rows.map(r => 
                        db.prepare("INSERT INTO suppliers (code, name) VALUES (?, ?)")
                          .bind(r.code, r.name)
                    );
                } else if (table === "managers") {
                    statements = rows.map(r => 
                        db.prepare("INSERT INTO managers (code, name) VALUES (?, ?)")
                          .bind(r.code, r.name)
                    );
                }

                // D1 batch 실행 (최대 100~500개 단위 분할 처리 권장)
                const chunkSize = 100;
                for (let i = 0; i < statements.length; i += chunkSize) {
                    await db.batch(statements.slice(i, i + chunkSize));
                }
            }

            // C. 🌟 업로드 날짜를 upload_metadata 테이블에 저장/업데이트 (UPSERT)
            if (uploadDate) {
                // 테이블이 없으면 자동 생성
                await db.prepare(`
                    CREATE TABLE IF NOT EXISTS upload_metadata (
                        table_name TEXT PRIMARY KEY,
                        last_upload_date TEXT
                    )
                `).run();

                // 날짜 정보 저장
                await db.prepare(`
                    INSERT INTO upload_metadata (table_name, last_upload_date) 
                    VALUES (?, ?)
                    ON CONFLICT(table_name) DO UPDATE SET last_upload_date = excluded.last_upload_date
                `).bind(table, uploadDate).run();
            }

            return new Response(JSON.stringify({ success: true, count: rows.length }), { headers: corsHeaders });
        }

        // =========================================================================
        // 3. 신규 발주 추가 (addEntry)
        // =========================================================================
        if (action === "addEntry" && request.method === "POST") {
            const e = await request.json();
            
            await db.prepare(`
                INSERT INTO entries (
                    id, del, check_status, recv, pCode, pName, pSpec, qty, 
                    vCode, vName, center, reg, regReason, date, 
                    supplierName, managerName, comp, compReasonSel, compReasonTxt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                e.id, 
                e.del ? 1 : 0, 
                e.check ? 1 : 0, 
                e.recv ? 1 : 0, 
                e.pCode, e.pName, e.pSpec, e.qty, 
                e.vCode, e.vName, e.center, e.reg, e.regReason, e.dateStr, 
                e.supplierName, e.managerName, e.comp || "", e.compReasonSel || "", e.compReasonTxt || ""
            ).run();

            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // =========================================================================
        // 4. 발주 상태 수정 (updateEntry)
        // =========================================================================
        if (action === "updateEntry" && request.method === "POST") {
            const { id, updates } = await request.json();
            
            let fields = [];
            let values = [];

            if (updates.check !== undefined) { fields.push("check_status = ?"); values.push(updates.check ? 1 : 0); }
            if (updates.recv !== undefined) { fields.push("recv = ?"); values.push(updates.recv ? 1 : 0); }
            if (updates.del !== undefined) { fields.push("del = ?"); values.push(updates.del ? 1 : 0); }
            if (updates.comp !== undefined) { fields.push("comp = ?"); values.push(updates.comp); }
            if (updates.compReasonSel !== undefined) { fields.push("compReasonSel = ?"); values.push(updates.compReasonSel); }
            if (updates.compReasonTxt !== undefined) { fields.push("compReasonTxt = ?"); values.push(updates.compReasonTxt); }

            if (fields.length > 0) {
                values.push(id);
                const query = `UPDATE entries SET ${fields.join(", ")} WHERE id = ?`;
                await db.prepare(query).bind(...values).run();
            }

            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // =========================================================================
        // 5. PIN 등록 및 관리 (addPin, deletePin)
        // =========================================================================
        if (action === "addPin" && request.method === "POST") {
            const { pin, name, approved } = await request.json();
            await db.prepare(`
                INSERT INTO pins (pin, name, approved) VALUES (?, ?, ?)
                ON CONFLICT(pin) DO UPDATE SET name = excluded.name, approved = excluded.approved
            `).bind(pin, name, approved ? 1 : 0).run();

            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (action === "deletePin" && request.method === "POST") {
            const { pin } = await request.json();
            await db.prepare("DELETE FROM pins WHERE pin = ?").bind(pin).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // =========================================================================
        // 6. 전체 초기화 (clearAllEntries, clearAllPins)
        // =========================================================================
        if (action === "clearAllEntries" && request.method === "POST") {
            await db.prepare("DELETE FROM entries").run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (action === "clearAllPins" && request.method === "POST") {
            await db.prepare("DELETE FROM pins").run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ error: "존재하지 않는 API 요청입니다." }), { status: 404, headers: corsHeaders });

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message || "서버 내부 오류가 발생했습니다." }), 
            { status: 500, headers: corsHeaders }
        );
    }
}
