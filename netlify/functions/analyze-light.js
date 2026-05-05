// netlify/functions/analyze-light.js
// גרסה: 2.0.0 | תאריך: 2026-05-04 | הוספת אימות ת.ז. + הגבלת שימושים יומית מתוך טבלת system_settings
// רק תלמידים מורשים יכולים להשתמש, ועד מקסימום השימושים שהוגדר

const FUNCTION_VERSION = '2.0.0';

async function supabaseRequest(path, options = {}) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return null;
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

async function logUsage(data) {
    try {
        const res = await supabaseRequest('/rest/v1/student_usage', {
            method: 'POST',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify(data)
        });
        if (res && !res.ok) {
            console.error('[log] Failed:', res.status);
        }
    } catch (err) {
        console.error('[log] Error:', err.message);
    }
}

exports.handler = async (event) => {
    console.log(`[analyze-light] v${FUNCTION_VERSION} invoked`);
    const startTime = Date.now();
    
    const ipAddress = event.headers['x-forwarded-for']?.split(',')[0]?.trim() 
        || event.headers['client-ip'] 
        || 'unknown';
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
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
        const { text, id_number } = JSON.parse(event.body || '{}');

        // ===== v2.0.0: ולידציית ת.ז. ובדיקת הרשאה =====
        if (!id_number || typeof id_number !== 'string') {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'נדרשת התחברות מחדש' })
            };
        }

        const cleanId = id_number.replace(/\D/g, '').trim();

        // בדיקה ב-Supabase שהת.ז. עדיין מורשית
        const authRes = await supabaseRequest(
            `/rest/v1/authorized_students?id_number=eq.${cleanId}&is_active=eq.true&select=id_number`
        );

        if (!authRes || !authRes.ok) {
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
                body: JSON.stringify({ error: 'תעודת הזהות לא מורשית במערכת' })
            };
        }

        // בדיקת מגבלת שימושים יומית
        const today = new Date().toISOString().split('T')[0];
        const usageRes = await supabaseRequest(
            `/rest/v1/student_usage?id_number=eq.${cleanId}&used_at=gte.${today}T00:00:00&select=id`
        );

        let usageCount = 0;
        if (usageRes && usageRes.ok) {
            const usageData = await usageRes.json();
            usageCount = usageData.length;
        }

        const settingsRes = await supabaseRequest(
            `/rest/v1/system_settings?key=eq.max_uses_per_day&select=value`
        );
        let maxUses = 3;
        if (settingsRes && settingsRes.ok) {
            const settingsData = await settingsRes.json();
            if (settingsData?.[0]?.value) {
                maxUses = parseInt(settingsData[0].value, 10) || 3;
            }
        }

        if (usageCount >= maxUses) {
            return {
                statusCode: 429,
                headers,
                body: JSON.stringify({ 
                    error: `הגעת למקסימום הבדיקות היומי (${maxUses}). אנא נסה שוב מחר או פנה למורה.`,
                    used_today: usageCount,
                    max_uses: maxUses
                })
            };
        }
        // ===== סוף בדיקות הרשאה =====

        // ולידציות טקסט
        if (!text || typeof text !== 'string') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'יש להזין טקסט לניתוח' })
            };
        }
        if (text.length < 50) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'הטקסט קצר מדי - יש להזין לפחות 50 תווים' })
            };
        }
        if (text.length > 10000) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'הטקסט ארוך מדי - מקסימום 10,000 תווים' })
            };
        }

        const API_KEY = process.env.GEMINI_API_KEY;
        if (!API_KEY) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'שגיאה: חסר API key במערכת' })
            };
        }

        // פרומפט קצר
        const prompt = `אתה מומחה לזיהוי תוכן שנכתב על ידי בינה מלאכותית בעברית. נתח את הטקסט הבא של תלמיד תקשורת בתיכון.

⚠️ הקשר חשוב: התלמיד **חייב** להשתמש במושגים מקצועיים (כגון: מסגור, הבניית מציאות, ספירלת השתיקה, סדר יום, דנוטציה, קונוטציה, סטריאוטיפים, אושיות רשת). שימוש במושגים אלה הוא דרישה ולא סימן ל-AI.
התמקד בסימנים אחרים: סגנון אחיד מדי, היעדר טעויות, חוסר קול אישי, מבנה משפטים מושלם מדי, חזרתיות, היעדר דוגמאות אישיות.

הטקסט:
"""
${text}
"""

החזר JSON בלבד (ללא טקסט נוסף):
{
  "ai_likelihood": <מספר שלם 0-100>,
  "verdict": "<אחד מ: 'human', 'mixed', 'ai', 'definitely_ai'>"
}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 2048,
                    responseMimeType: "application/json"
                }
            })
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error('[analyze-light] Gemini error:', errText);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'שגיאה בתקשורת עם שירות הניתוח',
                    details: errText.substring(0, 200)
                })
            };
        }

        const geminiData = await geminiResponse.json();
        const candidate = geminiData?.candidates?.[0];
        const responseText = candidate?.content?.parts?.[0]?.text;
        const finishReason = candidate?.finishReason;

        console.log(`[analyze-light] Response: finishReason=${finishReason}, len=${responseText?.length || 0}, took=${Date.now() - startTime}ms`);

        if (!responseText) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'לא התקבלה תשובה תקינה' })
            };
        }

        if (finishReason && finishReason !== 'STOP') {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'הניתוח הופסק - אנא נסה שוב',
                    finishReason
                })
            };
        }

        let analysis;
        try {
            let cleaned = responseText.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
            if (!cleaned.startsWith('{')) {
                const firstBrace = cleaned.indexOf('{');
                const lastBrace = cleaned.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) {
                    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
                }
            }
            analysis = JSON.parse(cleaned);
        } catch (parseErr) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'התשובה התקבלה אך לא בפורמט הנכון - אנא נסה שוב' })
            };
        }

        if (typeof analysis.ai_likelihood !== 'number' || !analysis.verdict) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'תשובה לא תקינה מהשירות - אנא נסה שוב' })
            };
        }

        // רישום שימוש בטבלת student_usage
        await logUsage({
            id_number: cleanId,
            ai_likelihood: analysis.ai_likelihood,
            verdict: analysis.verdict,
            text_length: text.length,
            ip_address: ipAddress
        });

        return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ai_likelihood: analysis.ai_likelihood,
                verdict: analysis.verdict,
                used_today: usageCount + 1,
                max_uses: maxUses,
                remaining: maxUses - (usageCount + 1),
                _version: FUNCTION_VERSION,
                _duration_ms: Date.now() - startTime
            })
        };

    } catch (err) {
        console.error('[analyze-light] Error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'שגיאה לא צפויה: ' + err.message })
        };
    }
};
