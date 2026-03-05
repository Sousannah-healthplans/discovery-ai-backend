# Local Development Setup

## Prerequisites
1. Node.js 18+ installed
2. MongoDB running locally OR MongoDB Atlas connection string

## Quick Start

### 1. Install Dependencies
```bash
cd discovery-ai-backend
npm install
```

### 2. Set Up Environment Variables
Create or update `.env` file with:

```env
# Server
PORT=4000

# Database (use local MongoDB or Atlas)
MONGO_URI=mongodb://127.0.0.1:27017/claims_demo
# OR for MongoDB Atlas:
# MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/claims_demo

# Cloudinary (optional - OCR works without it)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Extension API Key
EXTENSION_API_KEY=discovery_ext_7Kp9Xb2Q

# JWT Secret (generate a random string)
JWT_SECRET=your_secret_key_here_change_this
```

### 3. Start MongoDB (if using local)
```bash
# Windows (if installed as service, it should auto-start)
# Or download MongoDB Community Server and run:
mongod

# Or use MongoDB Atlas (cloud) - no local install needed
```

### 4. Run the Server
```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:4000`

### 5. Update Frontend to Use Local Backend
In `discovery-ai/.env`:
```env
REACT_APP_DISCOVERY_BACKEND=http://localhost:4000
```

Then restart the frontend:
```bash
cd discovery-ai
npm start
```

## Testing OCR

### Test with Manual OCR Endpoint
Once server is running, you can test OCR manually:

```bash
# Get a screenshot event ID from your database or API
# Then call:
curl -X POST http://localhost:4000/api/analytics/screenshots/EVENT_ID/process-ocr \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Reprocess Existing Screenshots
```bash
npm run reprocess-ocr
```

## Troubleshooting

### MongoDB Connection Issues
- Make sure MongoDB is running: `mongosh` or check service status
- Or use MongoDB Atlas (cloud) - update MONGO_URI in .env

### Port Already in Use
- Change PORT in .env to something else (e.g., 4001)
- Or kill the process using port 4000

### OCR Not Working
- Check that `tesseract.js` and `sharp` are installed: `npm list tesseract.js sharp`
- Check server logs for OCR errors
- Try the manual OCR endpoint first

