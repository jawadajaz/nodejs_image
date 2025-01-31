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
  const merchantDir = path.join(__dirname, `merchant_${merchantId}`);
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

    // Check if file already exists
    if (fs.existsSync(filePath)) {
      console.log('Serving cached image:', fileName);
      const imageBuffer = fs.readFileSync(filePath);
      res.set('Content-Type', `image/${format}`);
      return res.send(imageBuffer);
    }

    // Fetch and process the image
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer',
      timeout: 15000, // 15 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const imageBuffer = Buffer.from(response.data);

    // Prepare the Sharp transformation
    let transformer = sharp(imageBuffer);

    // Resize the image if width is provided
    if (width) {
      const parsedWidth = parseInt(width);
      if (!isNaN(parsedWidth) && parsedWidth > 0) {
        transformer = transformer.resize(parsedWidth);
      }
    }

    // Set the image format and quality
    const parsedQuality = quality ? parseInt(quality) : 80;
    transformer = transformer.toFormat(format, {
      quality: Math.min(Math.max(parsedQuality, 1), 100), // Ensure quality is between 1 and 100
    });

    // Process the image
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

app.listen(PORT, () => {
  console.log(`Image processing server running at http://localhost:${PORT}`);
});
