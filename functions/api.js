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
        // DB 연결 확인
        const db = env.DB;
        if (!db) {
            return new Response(
                JSON.stringify({ error: "D1 데이터베이스 바인딩(DB)을 찾을 수 없습니다." }),
                { status: 500, headers: corsHeaders }
            );
        }

        if (action === "getAll") {
            let entries=[], products=[], vendors=[], suppliers=[], managers=[], outofstock=[], pins=[], metadata=[];

            // 에러 방어 로직이 적용된 개별 데이터 조회
            try { entries = (await db.prepare("SELECT * FROM entries ORDER BY id DESC").all()).results; } catch(e) {}
            try { products = (await db.prepare("SELECT * FROM products").all()).results; } catch(e) {}
            try { vendors = (await db.prepare("SELECT * FROM vendors").all()).results; } catch(e) {}
            try { suppliers = (await db.prepare("SELECT * FROM suppliers").all()).results; } catch(e) {}
            try { managers = (await db.prepare("SELECT * FROM managers").all()).results; } catch(e) {}
            try { outofstock = (await db.prepare("SELECT * FROM outofstock").all()).results; } catch(e) {}
            try { pins = (await db.prepare("SELECT * FROM pins").all()).results; } catch(e) {}
            try { metadata = (await db.prepare("SELECT * FROM upload_metadata").all()).results; } catch(e) {}

            const uploadDatesMap = {};
            if (metadata && metadata.length > 0) {
                metadata.forEach(row => {
                    uploadDatesMap[row.table_name] = row.last_upload_date;
                });
            }

            return new Response(JSON.stringify({
                entries: entries || [],
                products: products || [],
                vendors: vendors || [],
                suppliers: suppliers || [],
                managers: managers || [],
                outofstock: outofstock || [],
                pins: pins || [],
                uploadDates: uploadDatesMap
            }), { headers: corsHeaders });
        }

        if (action === "uploadMaster" && request.method === "POST") {
            const { table, rows, uploadDate } = await request.json();

            if (!table || !Array.isArray(rows)) {
                return new Response(
                    JSON.stringify({ error: "잘못된 요청 형식입니다." }),
                    { status: 400, headers: corsHeaders }
                );
            }

            // 테이블 스키마 자동 업데이트 로직
            if (table === "outofstock") {
                await db.prepare(`
                    CREATE TABLE IF NOT EXISTS outofstock (
                        code TEXT,
                        name TEXT,
                        spec TEXT,
                        status TEXT,
                        schedule TEXT,
                        remark TEXT
                    )
                `).run();
            } else if (table === "products") {
                // 기존 products 테이블에 standardCode 컬럼이 없다면 자동 추가
                try {
                    await db.prepare("ALTER TABLE products ADD COLUMN standardCode TEXT").run();
                } catch (e) {
                    // 이미 컬럼이 존재하는 경우 발생하는 에러 무시
                }
            }

            await db.prepare(`DELETE FROM ${table}`).run();

            if (rows.length > 0) {
                let statements = [];
                if (table === "products") {
                    statements = rows.map(r =>
                        db.prepare("INSERT INTO products (code, name, spec, seller, standardCode) VALUES (?, ?, ?, ?, ?)")
                          .bind(r.code, r.name, r.spec, r.seller, r.standardCode)
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
                } else if (table === "outofstock") {
                    statements = rows.map(r =>
                        db.prepare("INSERT INTO outofstock (code, name, spec, status, schedule, remark) VALUES (?, ?, ?, ?, ?, ?)")
                          .bind(r.code, r.name, r.spec, r.status, r.schedule, r.remark)
                    );
                }

                const chunkSize = 100;
                for (let i = 0; i < statements.length; i += chunkSize) {
                    await db.batch(statements.slice(i, i + chunkSize));
                }
            }

            if (uploadDate) {
                await db.prepare(`
                    CREATE TABLE IF NOT EXISTS upload_metadata (
                        table_name TEXT PRIMARY KEY,
                        last_upload_date TEXT
                    )
                `).run();

                await db.prepare(`
                    INSERT INTO upload_metadata (table_name, last_upload_date)
                    VALUES (?, ?)
                    ON CONFLICT(table_name) DO UPDATE SET last_upload_date = excluded.last_upload_date
                `).bind(table, uploadDate).run();
            }

            return new Response(JSON.stringify({ success: true, count: rows.length }), { headers: corsHeaders });
        }

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

        if (action === "clearAllEntries" && request.method === "POST") {
            await db.prepare("DELETE FROM entries").run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        if (action === "clearOutOfStock" && request.method === "POST") {
            await db.prepare("DELETE FROM outofstock").run();
            await db.prepare("DELETE FROM upload_metadata WHERE table_name = 'outofstock'").run().catch(() => {});
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
