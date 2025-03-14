const express = require('express');
// Configure Sharp for serverless environment
process.env.SHARP_IGNORE_GLOBAL_LIBVIPS = 'true';

// Try to load Sharp with fallback
let sharp;
try {
  sharp = require('sharp');
  // Disable Sharp cache for serverless environment
  sharp.cache(false);
  // Limit concurrency to avoid memory issues
  sharp.concurrency(1);
} catch (error) {
  console.error('Warning: Sharp module failed to load:', error);
  // Create a minimal fallback implementation
  sharp = {
    cache: () => {},
    concurrency: () => {},
    create: () => ({
      jpeg: () => ({ toBuffer: () => Promise.resolve(Buffer.from([])) })
    })
  };
}

const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DateTime } = require('luxon');

// Cache axios instances and sharp pipeline
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

// Optimize sharp pipeline with fallback
const optimizeImage = async (buffer, width, quality, format = 'webp') => {
  try {
    // If Sharp is not properly loaded, just return the original buffer
    if (!sharp.resize) {
      console.log('Sharp not available, returning original image');
      return buffer;
    }

    // Create the initial transformer
    let transformer = sharp(buffer, {
      failOnError: false,
      limitInputPixels: 50000000, // Limit input size
      density: 72 // Optimize for web
    });

    // Handle width parameter first
    if (width) {
      const parsedWidth = parseInt(width);
      if (!isNaN(parsedWidth) && parsedWidth > 0) {
        console.log('Resizing image to width:', parsedWidth);
        transformer = transformer.resize(parsedWidth, null, {
          withoutEnlargement: true,
          fastShrink: true
        });
      }
    }

    // Set optimized defaults
    const options = {
      quality: quality ? Math.min(Math.max(parseInt(quality), 1), 100) : 80,
      effort: 4, // Balanced compression effort
      strip: true, // Remove metadata
    };

    // Apply format conversion
    transformer = transformer.toFormat(format, options);

    // Convert to buffer
    return transformer.toBuffer();
  } catch (error) {
    console.error('Sharp processing error:', error);
    // Return original buffer if processing fails
    return buffer;
  }
};

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format = 'webp' } = req.query;

  if (!url) {
    return res.status(400).send('Image URL is required');
  }

  try {
    const cacheKey = getCacheKey(url, width, quality, format);

    // Check in-memory cache first
    if (imageCache.has(cacheKey)) {
      const cachedImage = imageCache.get(cacheKey);
      res.set('Content-Type', `image/${format}`);
      res.set('X-Cache', 'HIT');
      return res.send(cachedImage);
    }

    // For serverless, use /tmp directory which is writable
    const tempDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'tmp');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFile = path.join(tempDir, `${cacheKey}.${format}`);
    
    // Check temp directory cache
    if (fs.existsSync(tempFile)) {
      const imageBuffer = fs.readFileSync(tempFile);
      imageCache.set(cacheKey, imageBuffer);
      res.set('Content-Type', `image/${format}`);
      res.set('X-Cache', 'DISK_HIT');
      return res.send(imageBuffer);
    }

    // Fetch and process image
    const response = await axiosInstance.get(url);
    const processedImage = await optimizeImage(response.data, width, quality, format);

    // Update cache
    imageCache.set(cacheKey, processedImage);
    if (imageCache.size > CACHE_SIZE) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }

    // Save to temp directory
    fs.writeFileSync(tempFile, processedImage);

    res.set('Content-Type', `image/${format}`);
    res.set('X-Cache', 'MISS');
    res.send(processedImage);

  } catch (error) {
    console.error('Error:', error.message);
    // If Sharp is not available, try to proxy the original image
    try {
      const response = await axiosInstance.get(url);
      res.set('Content-Type', `image/${format}`);
      res.set('X-Cache', 'PROXY');
      res.send(response.data);
    } catch (proxyError) {
      res.status(500).send(`Failed to process image: ${error.message}`);
    }
  }
});

app.get('/current-time', (req, res) => {
  const currentTime = DateTime.now().setZone('Asia/Karachi');

  res.json({
    date: currentTime.toFormat('dd-MM-yyyy'),
    time: currentTime.toFormat('HH:mm:ss')
  });
});

// Only warm up Sharp if it's properly loaded
if (sharp.resize) {
  sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).jpeg().toBuffer();
}

// For Vercel serverless, we need to export the app
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Only listen on a port when not on Vercel
  app.listen(PORT, () => {
    console.log(`Optimized image processing server running at http://localhost:${PORT}`);
  });
}