const express = require('express');
const sharp = require('sharp');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

// Optimize sharp pipeline
const optimizeImage = async (buffer, width, quality, format = 'webp') => {
  const transformer = sharp(buffer, {
    failOnError: false,
    density: 72 // Optimize for web
  });

  // Set optimized defaults
  const options = {
    quality: quality ? Math.min(Math.max(parseInt(quality), 1), 100) : 80,
    effort: 4, // Balanced compression effort
    strip: true, // Remove metadata
  };

  if (width) {
    const parsedWidth = parseInt(width);
    if (!isNaN(parsedWidth) && parsedWidth > 0) {
      transformer.resize(parsedWidth, null, {
        withoutEnlargement: true,
        fastShrink: true
      });
    }
  }

  return transformer
    .toFormat(format, options)
    .toBuffer();
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

    // Check temp directory cache
    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `${cacheKey}.${format}`);
    
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
    res.status(500).send(`Failed to process image: ${error.message}`);
  }
});

// Warm up Sharp (pre-initialize)
sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }
}).jpeg().toBuffer();

app.listen(PORT, () => {
  console.log(`Optimized image processing server running at http://localhost:${PORT}`);
});