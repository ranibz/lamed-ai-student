// netlify/functions/admin.js
// גרסה: 1.0.0 | תאריך: 2026-05-04 | פונקציית ניהול: רשימת תלמידים, הוספה/הסרה, סטטיסטיקות, הגדרות
// מאובטח באמצעות סיסמת אדמין הקבועה ב-env var ADMIN_PASSWORD

const FUNCTION_VERSION = '1.0.0';

async function supabaseRequest(path, options = {}) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Supabase לא מוגדר');
    }
    
    return await fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { action, password } = body;
        
        // אימות סיסמה
        const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin1234';
        if (password !== ADMIN_PASS) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'סיסמה שגויה' }) };
        }

        // ============= פעולות =============
        switch (action) {
            
            case 'list_students': {
                const res = await supabaseRequest('/rest/v1/authorized_students?select=*&order=created_at.desc');
                if (!res.ok) throw new Error('שגיאה בטעינת רשימה');
                const students = await res.json();
                return { statusCode: 200, headers, body: JSON.stringify({ students }) };
            }
            
            case 'add_student': {
                const { id_number, full_name, class_name } = body;
                if (!id_number) throw new Error('חסרה ת.ז.');
                
                const cleanId = String(id_number).replace(/\D/g, '');
                const res = await supabaseRequest('/rest/v1/authorized_students', {
                    method: 'POST',
                    headers: { 'Prefer': 'return=minimal' },
                    body: JSON.stringify({
                        id_number: cleanId,
                        full_name: full_name || null,
                        class_name: class_name || null,
                        is_active: true
                    })
                });
                
                if (!res.ok) {
                    const errText = await res.text();
                    if (errText.includes('duplicate') || errText.includes('unique')) {
                        throw new Error('ת.ז. זו כבר קיימת ברשימה');
                    }
                    throw new Error('שגיאה בהוספה: ' + errText.substring(0, 100));
                }
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }
            
            case 'add_students_bulk': {
                const { students } = body;
                if (!students || !Array.isArray(students)) throw new Error('נתונים לא תקינים');
                
                let added = 0;
                let skipped = 0;
                
                for (const s of students) {
                    const cleanId = String(s.id_number).replace(/\D/g, '');
                    if (cleanId.length < 7 || cleanId.length > 9) { skipped++; continue; }
                    
                    const res = await supabaseRequest('/rest/v1/authorized_students', {
                        method: 'POST',
                        headers: { 'Prefer': 'return=minimal' },
                        body: JSON.stringify({
                            id_number: cleanId,
                            full_name: s.full_name || null,
                            class_name: s.class_name || null,
                            is_active: true
                        })
                    });
                    
                    if (res.ok) added++;
                    else skipped++;
                }
                
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, added, skipped }) };
            }
            
            case 'replace_students': {
                const { students } = body;
                if (!students || !Array.isArray(students)) throw new Error('נתונים לא תקינים');
                
                // מחיקת כל הקיים
                await supabaseRequest('/rest/v1/authorized_students?id=gt.0', {
                    method: 'DELETE'
                });
                
                let added = 0;
                let skipped = 0;
                
                // הוספה מחדש
                for (const s of students) {
                    const cleanId = String(s.id_number).replace(/\D/g, '');
                    if (cleanId.length < 7 || cleanId.length > 9) { skipped++; continue; }
                    
                    const res = await supabaseRequest('/rest/v1/authorized_students', {
                        method: 'POST',
                        headers: { 'Prefer': 'return=minimal' },
                        body: JSON.stringify({
                            id_number: cleanId,
                            full_name: s.full_name || null,
                            class_name: s.class_name || null,
                            is_active: true
                        })
                    });
                    
                    if (res.ok) added++;
                    else skipped++;
                }
                
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, added, skipped }) };
            }
            
            case 'remove_student': {
                const { id_number } = body;
                if (!id_number) throw new Error('חסרה ת.ז.');
                
                const cleanId = String(id_number).replace(/\D/g, '');
                const res = await supabaseRequest(`/rest/v1/authorized_students?id_number=eq.${cleanId}`, {
                    method: 'DELETE'
                });
                
                if (!res.ok) throw new Error('שגיאה במחיקה');
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }
            
            case 'reset_usage': {
                const { id_number } = body;
                if (!id_number) throw new Error('חסרה ת.ז.');
                
                const cleanId = String(id_number).replace(/\D/g, '');
                const today = new Date().toISOString().split('T')[0];
                
                const res = await supabaseRequest(
                    `/rest/v1/student_usage?id_number=eq.${cleanId}&used_at=gte.${today}T00:00:00`,
                    { method: 'DELETE' }
                );
                
                if (!res.ok) throw new Error('שגיאה באיפוס');
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }
            
            case 'stats': {
                // סך כל התלמידים
                const studentsRes = await supabaseRequest('/rest/v1/authorized_students?is_active=eq.true&select=id', {
                    headers: { 'Prefer': 'count=exact' }
                });
                const totalStudents = parseInt(studentsRes.headers.get('content-range')?.split('/')[1] || '0', 10);
                
                // בדיקות היום
                const today = new Date().toISOString().split('T')[0];
                const todayRes = await supabaseRequest(
                    `/rest/v1/student_usage?used_at=gte.${today}T00:00:00&select=id_number`
                );
                const todayData = todayRes.ok ? await todayRes.json() : [];
                
                // בדיקות 7 ימים
                const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const weekRes = await supabaseRequest(
                    `/rest/v1/student_usage?used_at=gte.${weekAgo}T00:00:00&select=id`,
                    { headers: { 'Prefer': 'count=exact' } }
                );
                const usesWeek = parseInt(weekRes.headers.get('content-range')?.split('/')[1] || '0', 10);
                
                // בדיקות 30 ימים
                const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const monthRes = await supabaseRequest(
                    `/rest/v1/student_usage?used_at=gte.${monthAgo}T00:00:00&select=id`,
                    { headers: { 'Prefer': 'count=exact' } }
                );
                const uses30Days = parseInt(monthRes.headers.get('content-range')?.split('/')[1] || '0', 10);
                
                // ספירה לפי תלמיד היום
                const usageByStudent = {};
                todayData.forEach(u => {
                    usageByStudent[u.id_number] = (usageByStudent[u.id_number] || 0) + 1;
                });
                
                // הצלבה עם שמות תלמידים
                const allStudentsRes = await supabaseRequest('/rest/v1/authorized_students?select=id_number,full_name');
                const allStudents = allStudentsRes.ok ? await allStudentsRes.json() : [];
                const namesById = Object.fromEntries(allStudents.map(s => [s.id_number, s.full_name]));
                
                const usage_today = Object.entries(usageByStudent)
                    .map(([id_number, count]) => ({ id_number, count, full_name: namesById[id_number] || null }))
                    .sort((a, b) => b.count - a.count);
                
                return { 
                    statusCode: 200, 
                    headers, 
                    body: JSON.stringify({ 
                        total_students: totalStudents,
                        uses_today: todayData.length,
                        uses_week: usesWeek,
                        uses_30days: uses30Days,
                        usage_today
                    }) 
                };
            }
            
            case 'get_settings': {
                const res = await supabaseRequest('/rest/v1/system_settings?select=*');
                if (!res.ok) throw new Error('שגיאה בטעינה');
                const settings = await res.json();
                const result = {};
                settings.forEach(s => result[s.key] = s.value);
                return { statusCode: 200, headers, body: JSON.stringify(result) };
            }
            
            case 'set_setting': {
                const { key, value } = body;
                if (!key) throw new Error('חסר key');
                
                // upsert
                const res = await supabaseRequest('/rest/v1/system_settings', {
                    method: 'POST',
                    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify({ key, value: String(value) })
                });
                
                if (!res.ok) {
                    // נסה PATCH אם POST לא עבד
                    const patchRes = await supabaseRequest(`/rest/v1/system_settings?key=eq.${key}`, {
                        method: 'PATCH',
                        headers: { 'Prefer': 'return=minimal' },
                        body: JSON.stringify({ value: String(value) })
                    });
                    if (!patchRes.ok) throw new Error('שגיאה בשמירה');
                }
                
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }
            
            default:
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'פעולה לא ידועה' }) };
        }

    } catch (err) {
        console.error('[admin] Error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message || 'שגיאה לא צפויה' })
        };
    }
};
