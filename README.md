# Arabic Word Reader — Live MVP 0.2

الهدف الآن هو القراءة الحية داخل Word، لا تصدير ملف صوتي.

- يقرأ النص المحدد.
- Piper عربي محلي `ar_JO-kareem-medium`.
- يستخدم محاذاة Piper للـphonemes ثم يحولها إلى توقيتات كلمات.
- يشغل الصوت في الذاكرة.
- يظلل الكلمة الحالية مؤقتًا داخل Word ويحرّك Word إليها.
- إيقاف مؤقت/استكمال/إيقاف.
- السرعة: 0.75x و1x و1.25x و1.5x.

Microsoft Word يوفر `Range.highlight()` و`removeHighlight()` كتظليل مؤقت لا يغير محتوى المستند، و`Range.select()` لتحريك واجهة Word إلى النطاق. Piper 1.8.0 يدعم alignments عبر `include_alignments=True`، ويتطلب extra باسم `alignment`.

## على مشروعك الحالي

احتفظ بملفي النموذج الموجودين في `backend/models/`، ثم استبدل `backend/` و`addin/` و`scripts/` بالنسخ الموجودة هنا.

ثم:

```powershell
.\.venv\Scripts\python.exe -m pip install --upgrade -r backend\requirements.txt
.\scripts\test-live-backend.ps1
```

شغّل Backend:

```powershell
.\scripts\start-backend.ps1
```

وفي نافذة ثانية:

```powershell
cd .\addin
npm install
npx office-addin-dev-certs install
npm run dev
```

ثم sideload لملف `addin\manifest.xml` في Word.

ملاحظة: يستخدم الـMVP bookmark مخفيًا باسم `_AWR_*` لتثبيت نطاق القراءة حتى لو تحركت واجهة Word. يتم حذفه عند التوقف أو انتهاء القراءة.
