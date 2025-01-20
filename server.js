const express = require('express');
const sharp = require('sharp');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.get('/process-image', async (req, res) => {
  const { url, width, quality, format } = req.query;

  if (!url) {
    return res.status(400).send('Image URL is required');
  }

  try {
    // Fetch the image from the provided URL
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data);

    // Prepare the Sharp transformation
    let transformer = sharp(imageBuffer);

    // Resize the image if width is provided
    if (width) {
      transformer = transformer.resize(parseInt(width));
    }

    // Set the image format and quality
    if (format) {
      transformer = transformer.toFormat(format, {
        quality: quality ? parseInt(quality) : 80, // Default quality to 80
      });
    }

    // Process the image and send it as the response
    const processedImage = await transformer.toBuffer();
    res.set('Content-Type', `image/${format || 'jpeg'}`);
    res.send(processedImage);
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Failed to process the image');
  }
});

app.listen(PORT, () => {
  console.log(`Image processing server running at http://localhost:${PORT}`);
});
