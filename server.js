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
  const metadataPath = path.join(merchantDir, 'metadata.json');
  let existingMetadata = {};
  
  if (fs.existsSync(metadataPath)) {
    existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  
  existingMetadata[fileName] = metadata;
  fs.writeFileSync(metadataPath, JSON.stringify(existingMetadata, null, 2));
}

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format = 'webp', merchantId } = req.query;

  if (!url || !merchantId) {
    return res.status(400).send('Image URL and merchant ID are required');
  }

  try {
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
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data);

    // Prepare the Sharp transformation
    let transformer = sharp(imageBuffer);

    // Resize the image if width is provided
    if (width) {
      transformer = transformer.resize(parseInt(width));
    }

    // Set the image format and quality
    transformer = transformer.toFormat(format, {
      quality: quality ? parseInt(quality) : 80,
    });

    // Process the image
    const processedImage = await transformer.toBuffer();

    // Save the processed image
    fs.writeFileSync(filePath, processedImage);

    // Save metadata
    const metadata = {
      url,
      width: width || 'original',
      quality: quality || 80,
      format,
      merchantId,
      createdAt: new Date().toISOString()
    };
    saveMetadata(merchantDir, fileName, metadata);

    res.set('Content-Type', `image/${format}`);
    res.send(processedImage);
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Failed to process the image');
  }
});

app.listen(PORT, () => {
  console.log(`Image processing server running at http://localhost:${PORT}`);
});
