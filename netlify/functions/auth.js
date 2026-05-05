// netlify/functions/auth.js
// גרסה: 1.0.0 | תאריך: 2026-05-04 | פונקציית אימות: בודקת אם תעודת זהות מורשית להשתמש במערכת
// יוצרת אוטומטית את הטבלאות הנדרשות בפעם הראשונה

const FUNCTION_VERSION = '1.0.0';

// SQL ליצירת הטבלאות (מורץ פעם אחת בפעם הראשונה)
const SETUP_SQL = `
-- טבלת תלמידים מורשים
CREATE TABLE IF NOT EXISTS authorized_students (
    id BIGSERIAL PRIMARY KEY,
    id_number TEXT UNIQUE NOT NULL,
    full_name TEXT,
    class_name TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- טבלת רישום שימושים
CREATE TABLE IF NOT EXISTS student_usage (
    id BIGSERIAL PRIMARY KEY,
    id_number TEXT NOT NULL,
    used_at TIMESTAMPTZ DEFAULT NOW(),
    ai_likelihood INTEGER,
    verdict TEXT,
    text_length INTEGER,
    ip_address TEXT
);

-- טבלת הגדרות מערכת
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- הגדרת ברירת מחדל - 3 בדיקות ליום
INSERT INTO system_settings (key, value)
VALUES ('max_uses_per_day', '3')
ON CONFLICT (key) DO NOTHING;

-- אינדקסים לשליפה מהירה
CREATE INDEX IF NOT EXISTS idx_authorized_id ON authorized_students(id_number);
CREATE INDEX IF NOT EXISTS idx_usage_id_date ON student_usage(id_number, used_at);
`;

async function supabaseRequest(path, options = {}) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Supabase לא מוגדר במערכת');
    }
    
    const res = await fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    
    return res;
}

exports.handler = async (event) => {
    console.log(`[auth] v${FUNCTION_VERSION} invoked`);
    
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
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { id_number, action } = JSON.parse(event.body || '{}');

        // פעולת setup - יצירת טבלאות (פעם אחת)
        if (action === 'setup') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: 'יש להריץ את ה-SQL הבא ב-Supabase SQL Editor:',
                    sql: SETUP_SQL
                })
            };
        }

        // ולידציה של ת.ז.
        if (!id_number || typeof id_number !== 'string') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'יש להזין תעודת זהות' })
            };
        }

        const cleanId = id_number.replace(/\D/g, '').trim();
        
        if (cleanId.length < 7 || cleanId.length > 9) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'תעודת זהות לא תקינה - צריכה להיות בין 7 ל-9 ספרות' })
            };
        }

        // בדיקה אם ת.ז. ברשימה המורשית
        const authRes = await supabaseRequest(
            `/rest/v1/authorized_students?id_number=eq.${cleanId}&is_active=eq.true&select=id_number,full_name,class_name`
        );

        if (!authRes.ok) {
            console.error('[auth] Supabase auth check failed:', authRes.status, await authRes.text());
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'שגיאה במערכת - אנא נסה שוב' })
            };
        }

        const authData = await authRes.json();
        
        if (!authData || authData.length === 0) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ 
                    error: 'תעודת זהות לא רשומה במערכת. פנה למורה לקבלת הרשאה.',
                    authorized: false
                })
            };
        }

        const student = authData[0];

        // בדיקת מספר השימושים היום
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const usageRes = await supabaseRequest(
            `/rest/v1/student_usage?id_number=eq.${cleanId}&used_at=gte.${today}T00:00:00&select=id`
        );

        let usageCount = 0;
        if (usageRes.ok) {
            const usageData = await usageRes.json();
            usageCount = usageData.length;
        }

        // קבלת המגבלה היומית
        const settingsRes = await supabaseRequest(
            `/rest/v1/system_settings?key=eq.max_uses_per_day&select=value`
        );
        let maxUses = 3;
        if (settingsRes.ok) {
            const settingsData = await settingsRes.json();
            if (settingsData?.[0]?.value) {
                maxUses = parseInt(settingsData[0].value, 10) || 3;
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                authorized: true,
                id_number: cleanId,
                full_name: student.full_name || '',
                class_name: student.class_name || '',
                used_today: usageCount,
                max_uses: maxUses,
                remaining: Math.max(0, maxUses - usageCount),
                _version: FUNCTION_VERSION
            })
        };

    } catch (err) {
        console.error('[auth] Error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'שגיאה לא צפויה: ' + err.message })
        };
    }
};
