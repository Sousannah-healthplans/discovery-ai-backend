# Testing OCR Locally

## Backend is Running ✅
Your backend is running on `http://localhost:5000`

## Test OCR Processing

### 1. Check Backend Logs
When a screenshot is received, you should see:
```
[OCR] Screenshot queued for OCR processing (buffer size: X bytes)
[OCR] Processing X screenshots for OCR...
[OCR] Starting OCR processing for event ...
[OCR Service] Starting image preprocessing...
[OCR Service] OCR complete: X characters extracted
[OCR] ✅ Processed OCR for event ...
```

### 2. Test with Browser Extension
1. Make sure your browser extension is pointing to `http://localhost:5000`
2. Take a screenshot (it should automatically process OCR)
3. Check backend logs for OCR processing

### 3. Test Manual OCR Endpoint
If you have a screenshot event ID, you can manually trigger OCR:

```bash
# Get your auth token from browser localStorage or login
# Then call:
curl -X POST http://localhost:5000/api/analytics/screenshots/EVENT_ID/process-ocr \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

### 4. Reprocess Existing Screenshots
```bash
cd discovery-ai-backend
npm run reprocess-ocr
```

This will process all screenshots that don't have OCR data yet.

## Frontend Setup

1. Make sure `discovery-ai/.env` has:
   ```
   REACT_APP_DISCOVERY_BACKEND=http://localhost:5000
   ```

2. Restart your frontend:
   ```bash
   cd discovery-ai
   npm start
   ```

3. Open the Screenshots page and:
   - New screenshots will automatically process OCR
   - Click "Process OCR" button on existing screenshots
   - Tags should appear after processing

## Troubleshooting

### OCR Not Processing
- Check backend logs for `[OCR]` messages
- Make sure `tesseract.js` and `sharp` are installed: `npm list tesseract.js sharp`
- Try the manual OCR endpoint first

### No Tags Appearing
- Check browser console for errors
- Verify OCR completed in backend logs
- Try clicking "Process OCR" button manually
- Check that `ocrTags` array is not empty in the response

### MongoDB Connection
- Make sure MongoDB is running locally or use Atlas
- Check `MONGO_URI` in `.env` is correct

