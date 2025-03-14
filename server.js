const express = require('express');
const sharp = require('sharp');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DateTime } = require('luxon');

// Cache axios instances
const axiosInstance = axios.create({
  timeout: 10000,
  responseType: 'arraybuffer',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

const app = express();
const PORT = 3000;

// Enable CORS
app.use(cors());

// In-memory cache for recently processed images
const imageCache = new Map();
const CACHE_SIZE = 100; // Adjust based on your needs

// Generate cache key
const getCacheKey = (url, width, quality, format) => 
  crypto.createHash('md5').update(`${url}-${width}-${quality}-${format}`).digest('hex');

// Optimize image using Sharp
const optimizeImage = async (buffer, width, quality, format = 'webp') => {
  try {
    console.log('Starting image processing with parameters:', { width, quality, format });

    // Create Sharp instance
    let pipeline = sharp(buffer);

    // Get original metadata
    const metadata = await pipeline.metadata();
    console.log('Original dimensions:', {
      width: metadata.width,
      height: metadata.height
    });

    // Handle resize
    if (width) {
      const targetWidth = parseInt(width);
      if (!isNaN(targetWidth) && targetWidth > 0) {
        console.log(`Resizing to width: ${targetWidth}`);
        pipeline = pipeline.resize(targetWidth, null, {
          withoutEnlargement: true,
          fit: 'inside'
        });
      }
    }

    // Set quality
    const targetQuality = quality ? parseInt(quality) : 80;
    const normalizedQuality = Math.min(Math.max(targetQuality, 1), 100);
    console.log(`Setting quality to: ${normalizedQuality}`);

    // Convert to WebP with quality settings
    pipeline = pipeline.webp({
      quality: normalizedQuality,
      effort: 4
    });

    // Process the image
    const outputBuffer = await pipeline.toBuffer();

    // Verify final output
    const finalImage = sharp(outputBuffer);
    const finalMetadata = await finalImage.metadata();
    console.log('Final dimensions:', {
      width: finalMetadata.width,
      height: finalMetadata.height,
      format: finalMetadata.format
    });

    return outputBuffer;
  } catch (error) {
    console.error('Image processing error:', error);
    throw error;
  }
};

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format = 'webp' } = req.query;

  if (!url) {
    return res.status(400).send('Image URL is required');
  }

  // Parse and validate parameters
  const parsedWidth = width ? parseInt(width) : null;
  const parsedQuality = quality ? parseInt(quality) : null;

  console.log('Processing request:', {
    url,
    width: parsedWidth,
    quality: parsedQuality,
    format
  });

  try {
    const cacheKey = getCacheKey(url, parsedWidth, parsedQuality, format);

    // Check in-memory cache first
    if (imageCache.has(cacheKey)) {
      console.log('Serving from memory cache');
      const cachedImage = imageCache.get(cacheKey);
      res.set('Content-Type', 'image/webp');
      res.set('X-Cache', 'HIT');
      return res.send(cachedImage);
    }

    // For serverless, use /tmp directory which is writable
    const tempDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'tmp');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFile = path.join(tempDir, `${cacheKey}.webp`);
    
    // Check temp directory cache
    if (fs.existsSync(tempFile)) {
      console.log('Serving from disk cache');
      const imageBuffer = fs.readFileSync(tempFile);
      imageCache.set(cacheKey, imageBuffer);
      res.set('Content-Type', 'image/webp');
      res.set('X-Cache', 'DISK_HIT');
      return res.send(imageBuffer);
    }

    // Fetch image
    console.log('Fetching image from:', url);
    const response = await axiosInstance.get(url);
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Empty response from image URL');
    }

    // Process image
    const processedImage = await optimizeImage(
      response.data,
      parsedWidth,
      parsedQuality,
      format
    );

    if (!processedImage || processedImage.length === 0) {
      throw new Error('Image processing failed');
    }

    // Update cache
    imageCache.set(cacheKey, processedImage);
    if (imageCache.size > CACHE_SIZE) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }

    // Save to temp directory
    fs.writeFileSync(tempFile, processedImage);

    // Send response
    res.set('Content-Type', 'image/webp');
    res.set('X-Cache', 'MISS');
    res.send(processedImage);

  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send(`Failed to process image: ${error.message}`);
  }
});

app.get('/current-time', (req, res) => {
  const currentTime = DateTime.now().setZone('Asia/Karachi');

  res.json({
    datetime: currentTime.toFormat('EEE MMM dd yyyy HH:mm:ss \'GMT\'Z (z)')
  });
});

// For Vercel serverless, we need to export the app
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Only listen on a port when not on Vercel
  app.listen(PORT, () => {
    console.log(`Optimized image processing server running at http://localhost:${PORT}`);
  });
}