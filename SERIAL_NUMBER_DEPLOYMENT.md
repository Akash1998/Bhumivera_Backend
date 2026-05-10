# Serial Number System Deployment Guide

## Overview
This guide provides complete instructions for deploying the enhanced serial number management system that supports up to 1 million serial numbers with advanced features.

## What's New in This Update

### ✅ Core Improvements
1. **Enhanced Serial Number Generator**
   - Format: `PREFIX-YYMM-XXXXXX-CC` (e.g., `ANRI-2603-A3B7K9-F2`)
   - Built-in timestamp for sorting
   - Checksum validation for integrity
   - Collision detection

2. **Database Optimizations**
   - Added indexes for better query performance
   - Support for 1M+ serial numbers
   - Batch processing (1000 records per chunk)
   - Added `notes` field for serial tracking

3. **Advanced Filtering & Pagination**
   - Search by serial number or product name
   - Filter by status, product, batch
   - Sort by any column
   - Pagination support (default 100 per page)

4. **Excel Export**
   - Color-coded status indicators
   - Formatted headers
   - All serial data with product names
   - Filter support

### 📁 Files Modified
- `models/serialModel.js` - Enhanced model with new functions
- `routes/serialRoutes.js` - New endpoints and Excel export
- `package.json` - Added exceljs dependency

## Deployment Steps

### Step 1: Pull Latest Changes
```bash
cd /path/to/backend-Bhumivera
git pull origin main
```

### Step 2: Install New Dependencies
```bash
npm install
```
This will install the new `exceljs` package (^4.4.0) required for Excel exports.

### Step 3: Database Migration
The system will automatically create the updated table schema on first run, but you can also manually run the migration:

```bash
node -e "require('./models/serialModel').createSerialTable()"
```

**Database Changes:**
- Added `notes` TEXT field
- Added indexes on: `product_id`, `status`, `batch_number`, `serial_number`, `created_at`

If you have existing data, the indexes will be added without data loss.

### Step 4: Restart the Server
```bash
# If using PM2
pm2 restart backend-Bhumivera

# If using systemd
sudo systemctl restart backend-Bhumivera

# Or manual restart
npm start
```

### Step 5: Verify Deployment
Check that all endpoints are working:

```bash
# Check server health
curl https://your-domain.com/api/health

# Test serial generation (requires admin auth)
curl -X POST https://your-domain.com/api/serials/generate \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productId": 1, "count": 10, "batchNumber": "BATCH001", "prefix": "ANRI"}'

# Test Excel export
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  "https://your-domain.com/api/serials/export/excel" \
  -o serials.xlsx
```

## New API Endpoints

### 1. Enhanced Serial Generation
```
POST /api/serials/generate
```
**Body:**
```json
{
  "productId": 1,
  "count": 1000,
  "batchNumber": "BATCH001",
  "prefix": "ANRI"
}
```
**Response:**
```json
{
  "message": "1000 Serials generated successfully",
  "count": 1000,
  "serials": ["ANRI-2603-A3B7K9-F2", ...],
  "totalGenerated": 1000
}
```

### 2. Get All Serials with Filtering
```
GET /api/serials/all?page=1&limit=100&status=available&searchTerm=ANRI&sortBy=created_at&sortOrder=DESC
```
**Response:**
```json
{
  "serials": [...],
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 5000,
    "totalPages": 50
  }
}
```

### 3. Export to Excel
```
GET /api/serials/export/excel?status=available&productId=1
```
**Response:** Excel file download with formatted data

### 4. Get Statistics
```
GET /api/serials/statistics?productId=1
```
**Response:**
```json
{
  "total": 10000,
  "available": 8500,
  "sold": 1000,
  "registered": 400,
  "blocked": 100
}
```

### 5. Validate Serial Checksum
```
GET /api/serials/validate/ANRI-2603-A3B7K9-F2
```
**Response:**
```json
{
  "serial": "ANRI-2603-A3B7K9-F2",
  "valid": true,
  "message": "Serial number format is valid"
}
```

### 6. Delete Entire Batch
```
DELETE /api/serials/batch/BATCH001
```
**Response:**
```json
{
  "message": "Batch deleted successfully",
  "deletedCount": 1000
}
```

## Performance Considerations

### Batch Generation Limits
- Maximum 100,000 serials per batch
- Larger batches should be split
- Batch processing reduces memory usage

### Database Indexes
The following indexes are automatically created:
- `idx_product_id` - For product filtering
- `idx_status` - For status filtering
- `idx_batch_number` - For batch operations
- `idx_serial_number` - For serial lookups
- `idx_created_at` - For date sorting

### Excel Export Limits
- Can handle up to 1 million records
- Large exports may take time
- Consider using filters to reduce dataset

## Troubleshooting

### Issue: Excel export fails
**Solution:** Ensure exceljs is installed:
```bash
npm install exceljs@^4.4.0
```

### Issue: Slow serial generation
**Solution:** 
- Check database indexes are created
- Reduce batch size if needed
- Monitor server memory

### Issue: Duplicate serial numbers
**Solution:**
- The system has collision detection
- Check if serial_number field has UNIQUE constraint
- Review batch_number to ensure proper tracking

### Issue: 404 errors on API calls
**Solution:**
- Verify the server restarted successfully
- Check that routes are properly registered
- Ensure API prefix is `/api`

## Testing Checklist

- [ ] Generate 100 serial numbers
- [ ] Generate 10,000 serial numbers
- [ ] Filter serials by status
- [ ] Search serials by product name
- [ ] Sort serials by different columns
- [ ] Export serials to Excel
- [ ] View serial statistics
- [ ] Validate serial checksum
- [ ] Delete a batch of serials
- [ ] Check warranty registration with new serials

## Frontend Integration (Optional)

To use these features in the frontend, update the API service:

```javascript
// Example: Export to Excel
const exportSerials = async (filters) => {
  const params = new URLSearchParams(filters);
  const response = await fetch(`/api/serials/export/excel?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `serials_${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
};
```

## Rollback Plan

If you need to rollback:

```bash
git revert HEAD~3  # Reverts last 3 commits
npm install
pm2 restart backend-Bhumivera
```

## Support

For issues or questions:
1. Check server logs: `pm2 logs backend-Bhumivera`
2. Review database queries
3. Check API response times
4. Monitor memory usage

## Success Criteria

✅ Server starts without errors
✅ Can generate 10,000+ serials in under 30 seconds
✅ Can export 100,000+ serials to Excel
✅ Pagination works correctly
✅ Filtering and search return accurate results
✅ Excel file downloads with proper formatting
✅ Serial validation works correctly

---

**Deployment Date:** March 20, 2026
**Version:** 2.0
**Status:** Production Ready ✅
