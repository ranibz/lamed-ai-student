// netlify/functions/analyze-light.js
// גרסה: 1.0.1 | תאריך: 2026-05-04 | תיקון: maxOutputTokens 256→2048 (Gemini 2.5 Flash צורך טוקנים ל-thinking פנימי לפני הפלט)

const FUNCTION_VERSION = '1.0.1';

// פונקציית עזר - שמירת רישום ב-Supabase (אופציונלי)
async function logToSupabase(data) {
    try {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_KEY = process.env.SUPABASE_KEY;
        
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            return;
        }
        
        await fetch(`${SUPABASE_URL}/rest/v1/ai_checker_logs`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(data)
        });
    } catch (err) {
        console.error('[log] Failed:', err.message);
    }
}

exports.handler = async (event, context) => {
    console.log(`[analyze-light] v${FUNCTION_VERSION} invoked`);
    const startTime = Date.now();
    
    const ipAddress = event.headers['x-forwarded-for']?.split(',')[0]?.trim() 
        || event.headers['client-ip'] 
        || 'unknown';
    const userAgent = event.headers['user-agent'] || 'unknown';
    
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
        const { text } = JSON.parse(event.body || '{}');

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

        // פרומפט קצר ומדויק - רק אחוז וורדיקט
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
            console.error('[analyze-light] Parse error:', parseErr.message, 'raw:', responseText.substring(0, 300));
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'התשובה התקבלה אך לא בפורמט הנכון - אנא נסה שוב' })
            };
        }

        // ולידציה של התוצאה
        if (typeof analysis.ai_likelihood !== 'number' || !analysis.verdict) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'תשובה לא תקינה מהשירות - אנא נסה שוב' })
            };
        }

        // תיעוד ב-Supabase
        await logToSupabase({
            ai_likelihood: analysis.ai_likelihood,
            verdict: analysis.verdict,
            text_length: text.length,
            ip_address: ipAddress,
            user_agent: userAgent.substring(0, 200),
            duration_ms: Date.now() - startTime,
            success: true
        });

        return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ai_likelihood: analysis.ai_likelihood,
                verdict: analysis.verdict,
                _version: FUNCTION_VERSION,
                _duration_ms: Date.now() - startTime
            })
        };

    } catch (err) {
        console.error('[analyze-light] Function error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'שגיאה לא צפויה: ' + err.message })
        };
    }
};
