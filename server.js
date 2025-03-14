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

    console.log('Starting image processing with parameters:', { width, quality, format });

    // Create sharp instance with the input buffer
    const image = sharp(buffer);

    // Get image metadata
    const metadata = await image.metadata();
    console.log('Original image metadata:', metadata);

    // Create a new transformer pipeline
    let transformer = sharp(buffer);

    // Apply resize if width is specified
    if (width) {
      const targetWidth = parseInt(width);
      if (!isNaN(targetWidth) && targetWidth > 0) {
        console.log(`Applying resize to width: ${targetWidth}`);
        await transformer.resize(targetWidth, null, {
          withoutEnlargement: true,
          fit: sharp.fit.contain
        });
        
        // Verify resize
        const resizedMetadata = await transformer.metadata();
        console.log('After resize metadata:', resizedMetadata);
      }
    }

    // Set quality for compression
    const targetQuality = quality ? parseInt(quality) : 80;
    const normalizedQuality = Math.min(Math.max(targetQuality, 1), 100);
    
    console.log(`Applying format conversion with quality: ${normalizedQuality}`);
    
    // Apply format conversion with quality
    const formatOptions = {
      quality: normalizedQuality,
      effort: 4,
      strip: true
    };

    // Convert to specified format
    await transformer.toFormat(format, formatOptions);

    // Generate final buffer
    console.log('Generating final buffer...');
    const outputBuffer = await transformer.toBuffer();
    
    // Verify final output
    const finalMetadata = await sharp(outputBuffer).metadata();
    console.log('Final image metadata:', finalMetadata);

    return outputBuffer;
  } catch (error) {
    console.error('Sharp processing error:', error);
    throw error; // Let the main handler deal with the error
  }
};

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format = 'webp' } = req.query;

  if (!url) {
    return res.status(400).send('Image URL is required');
  }

  console.log('Received request with parameters:', {
    url,
    width: width || 'original',
    quality: quality || 'default',
    format
  });

  try {
    const cacheKey = getCacheKey(url, width, quality, format);

    // Check in-memory cache first
    if (imageCache.has(cacheKey)) {
      console.log('Serving from memory cache');
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
      console.log('Serving from disk cache');
      const imageBuffer = fs.readFileSync(tempFile);
      imageCache.set(cacheKey, imageBuffer);
      res.set('Content-Type', `image/${format}`);
      res.set('X-Cache', 'DISK_HIT');
      return res.send(imageBuffer);
    }

    // Fetch and process image
    console.log('Fetching image from URL:', url);
    const response = await axiosInstance.get(url);
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Empty response from image URL');
    }

    console.log('Image fetched successfully, size:', response.data.length);
    
    const processedImage = await optimizeImage(response.data, width, quality, format);
    
    if (!processedImage || processedImage.length === 0) {
      throw new Error('Image processing failed to produce output');
    }

    console.log('Image processed successfully, size:', processedImage.length);

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
    console.error('Error processing image:', error);
    res.status(500).send(`Failed to process image: ${error.message}`);
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