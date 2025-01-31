const express = require('express');
const sharp = require('sharp');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

app.use(cors());

// Create a function to generate a unique filename based on parameters
function generateFileName(url, width, quality, format, merchantId) {
  const hash = crypto.createHash('md5').update(`${url}-${width}-${quality}-${format}`).digest('hex');
  return `${hash}.${format || 'webp'}`;
}

// Function to ensure merchant directory exists
function ensureMerchantDir(merchantId) {
  // Use /tmp directory for Vercel
  const merchantDir = path.join('/tmp', `merchant_${merchantId}`);
  if (!fs.existsSync(merchantDir)) {
    fs.mkdirSync(merchantDir, { recursive: true });
  }
  return merchantDir;
}

// Function to save metadata
function saveMetadata(merchantDir, fileName, metadata) {
  try {
    const metadataPath = path.join(merchantDir, 'metadata.json');
    let existingMetadata = {};
    
    if (fs.existsSync(metadataPath)) {
      existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    }
    
    existingMetadata[fileName] = metadata;
    fs.writeFileSync(metadataPath, JSON.stringify(existingMetadata, null, 2));
  } catch (error) {
    console.error('Error saving metadata:', error);
  }
}

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format = 'webp', merchantId } = req.query;

  if (!url || !merchantId) {
    return res.status(400).send('Image URL and merchant ID are required');
  }

  try {
    // Validate URL
    const validUrl = new URL(url);

    const merchantDir = ensureMerchantDir(merchantId);
    const fileName = generateFileName(url, width, quality, format, merchantId);
    const filePath = path.join(merchantDir, fileName);

    // Check if file already exists in merchant directory
    if (fs.existsSync(filePath)) {
      console.log('Serving cached image:', fileName);
      const imageBuffer = fs.readFileSync(filePath);
      res.set('Content-Type', `image/${format}`);
      return res.send(imageBuffer);
    }

    // Check metadata to see if this URL was processed before
    const metadataPath = path.join(merchantDir, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const existingEntry = Object.entries(metadata).find(([_, data]) => data.url === url);
      
      if (existingEntry) {
        const [existingFileName, existingData] = existingEntry;
        const existingFilePath = path.join(merchantDir, existingFileName);
        
        if (fs.existsSync(existingFilePath)) {
          console.log('Serving existing image with same URL:', existingFileName);
          const imageBuffer = fs.readFileSync(existingFilePath);
          res.set('Content-Type', `image/${existingData.format}`);
          return res.send(imageBuffer);
        }
      }
    }

    // If no existing file found, process the new image
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const imageBuffer = Buffer.from(response.data);
    let transformer = sharp(imageBuffer);

    if (width) {
      const parsedWidth = parseInt(width);
      if (!isNaN(parsedWidth) && parsedWidth > 0) {
        transformer = transformer.resize(parsedWidth);
      }
    }

    const parsedQuality = quality ? parseInt(quality) : 80;
    transformer = transformer.toFormat(format, {
      quality: Math.min(Math.max(parsedQuality, 1), 100),
    });

    const processedImage = await transformer.toBuffer();

    // Save the processed image
    fs.writeFileSync(filePath, processedImage);

    // Save metadata
    const metadata = {
      url,
      width: width || 'original',
      quality: parsedQuality,
      format,
      merchantId,
      createdAt: new Date().toISOString()
    };
    saveMetadata(merchantDir, fileName, metadata);

    res.set('Content-Type', `image/${format}`);
    res.send(processedImage);
  } catch (error) {
    console.error('Detailed error:', {
      message: error.message,
      stack: error.stack,
      url: url,
      merchantId: merchantId,
      width: width,
      quality: quality,
      format: format
    });

    if (error.response) {
      return res.status(error.response.status).send(`Failed to fetch image: ${error.message}`);
    }
    
    if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      return res.status(404).send('Image URL is not accessible');
    }

    res.status(500).send(`Failed to process the image: ${error.message}`);
  }
});

// Add new route to inspect temp directory
app.get('/inspect-temp', async (req, res) => {
  const { merchantId } = req.query;
  try {
    const baseDir = '/tmp';
    
    // If merchantId is provided, show specific merchant directory
    if (merchantId) {
      const merchantDir = path.join(baseDir, `merchant_${merchantId}`);
      if (!fs.existsSync(merchantDir)) {
        return res.json({ 
          message: `No directory found for merchant_${merchantId}`,
          exists: false 
        });
      }

      const files = fs.readdirSync(merchantDir);
      const dirInfo = {};

      // Get details for each file
      for (const file of files) {
        const filePath = path.join(merchantDir, file);
        const stats = fs.statSync(filePath);
        
        if (file === 'metadata.json') {
          dirInfo[file] = {
            size: stats.size,
            created: stats.birthtime,
            content: JSON.parse(fs.readFileSync(filePath, 'utf8'))
          };
        } else {
          dirInfo[file] = {
            size: stats.size,
            created: stats.birthtime
          };
        }
      }

      return res.json({
        merchantDir: `merchant_${merchantId}`,
        exists: true,
        fileCount: files.length,
        files: dirInfo
      });
    }

    // Show all merchant directories
    const contents = fs.readdirSync(baseDir)
      .filter(item => item.startsWith('merchant_'))
      .map(dir => {
        const fullPath = path.join(baseDir, dir);
        const stats = fs.statSync(fullPath);
        const files = fs.readdirSync(fullPath);
        return {
          directory: dir,
          fileCount: files.length,
          created: stats.birthtime,
          files: files
        };
      });

    res.json({
      tempDirectory: baseDir,
      merchantDirectories: contents
    });

  } catch (error) {
    console.error('Error inspecting temp directory:', error);
    res.status(500).json({
      error: 'Failed to inspect temp directory',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Image processing server running at http://localhost:${PORT}`);
});
