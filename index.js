const express = require('express');

//to reactivate import mode, adjust package.json to include under main node:
//"type": "module", 

//const fetch = require('node-fetch');
//var Request = require("request");

//const axios = require('axios');
const sharp = require('sharp');

const PORT = process.env.PORT || 80
const version = 0.1

const fs = require("fs"); // Or `import fs from "fs";` with ESM
const path = require('path');
//const S3 = require('aws-sdk').S3;


//const fs = require("fs");

var app = express()
var config = null

//const https = require('https');

//adding multer implementation to handle image uploads
const multer = require('multer');

const cors = require('cors');

app.use(cors());


//load configuration file
loadConfig();




const awsLink = config.AWS_LINK; 
const imagesDir = config.IMG_DIR;

const extraStoragePath = config.EXTRA_STRG;

// Multer configuration for storing uploaded images
const storage = multer.diskStorage({ 
	destination: function (req, file, cb) { 
		cb(null, path.join(__dirname, imagesDir)); 
	}, 
	filename: function (req, file, cb) { 
		cb(null, file.originalname); 
	} 
});

const fileFilter = (req, file, cb) => { 
	// Accept images only 
	console.log(file.mimetype);
	/*if (!file.mimetype.startsWith('image/')) { 
		return cb(new Error('Only image files are allowed!'), false); 
	} */
	cb(null, true); 
};

const upload = multer({ 
	storage: storage,
	fileFilter: fileFilter	
});




function loadConfig() {
	config = JSON.parse(fs.readFileSync("config.json"));
}



const secretKey = config.SEC_UPL_KEE;
const secondSecretKey = config.SEC_UPL_KEE_LEG;
//console.log(config.AWS_ACCESS_KEY_ID);
//console.log(config.AWS_SECRET_ACCESS_KEY);
/*let s3 = new S3({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    //region: config.AWS_REGION
});*/

async function fetchMeta(imgParam){
	let input = 'loadedimgs/'+imgParam;
	const metadata = await sharp(input).metadata();
	console.log(metadata);
	let inst = sharp('loadedimgs/'+imgParam).rotate().toFile('loadedimgs/'+imgParam+'_fixed');
	return;
}


function verifySecretKey(req, res, next) {
  const token = req.headers['authorization'];

  if (token !== secretKey && token !== secondSecretKey) {
    return res.status(403).send('Unauthorized access. Invalid token.');
  }

  next();
}

// Helper: Universally handles image orientation for all formats.
async function fixOrientationAndStripExif(filePath) {
  try {
    // 1. Read the original file into a buffer. This works for any format.
    const originalBuffer = await fs.promises.readFile(filePath);

    // 2. Get the image's true metadata from the buffer.
    const metadata = await sharp(originalBuffer).metadata();

    // 3. Check if an orientation tag exists and requires rotation.
    //    (This tag is typically only found in JPEG and TIFF files).
    if (!metadata.orientation || metadata.orientation === 1) {
      // If orientation is normal or doesn't exist (e.g., for a PNG), do nothing.
      console.log(`Image ${filePath} (format: ${metadata.format}) does not require rotation. File left untouched.`);
      return {
        rotated: false,
        metadataBefore: metadata
      };
    }

    // 4. If we get here, rotation IS required. Calculate the angle.
    let rotationAngle = 0;
    switch (metadata.orientation) {
      case 3: rotationAngle = 180; break;
      case 6: rotationAngle = 90; break;
      case 8: rotationAngle = 270; break;
    }
    
    console.log(`Image ${filePath} (format: ${metadata.format}) has orientation tag ${metadata.orientation}. Applying ${rotationAngle}-degree rotation.`);

    // 5. Create a new buffer with the physically rotated image.
    //    Sharp will automatically preserve the original format (JPEG, etc.).
    const rotatedBuffer = await sharp(originalBuffer)
      .rotate(rotationAngle)
      .toBuffer();

    // 6. Overwrite the original file with the new, corrected buffer.
    await fs.promises.writeFile(filePath, rotatedBuffer);

    console.log(`Successfully rotated and saved ${filePath}.`);

    return {
      rotated: true,
      metadataBefore: metadata
    };

  } catch (err) {
    console.error(`CRITICAL: An error occurred during orientation check for ${filePath}.`, err);
    throw err;
  }
}


app.get('/', async function (req,res){
	res.send('EHLO');
})

app.post('/upload', verifySecretKey, upload.single('image'), async function (req, res) { 
	try { 
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const savedPath = req.file.path; // full path where multer saved the file
    console.log('Uploaded file info:', req.file);

    try {
      const result = await fixOrientationAndStripExif(savedPath);
      console.log('fixOrientationAndStripExif result:', result);
      // Send response back to client 
      return res.status(200).json({
        message: 'Image uploaded and processed successfully!',
        rotated: result.rotated,
        originalMetadata: {
          format: result.metadataBefore.format,
          size: result.metadataBefore.size,
          orientation: result.metadataBefore.orientation || 1
        }
      });
    } catch (processingErr) {
      console.error('Error processing image:', processingErr);
      // Optionally return success for upload but warn about processing error:
      return res.status(500).json({ message: 'Image uploaded but failed to process orientation/EXIF.', error: processingErr.message });
    }

  } catch (err) { 
    console.error('Upload error:', err);
    res.status(500).send('An error occurred while uploading the image.');
  }
});

app.get('/fetchMeta/:imgParam', async function (req, res){
	let outc = await fetchMeta(req.params.imgParam);
	res.send('done');
})


app.get('/deleteOrigin', async function (req, res){
	const files = await fs.promises.readdir(__dirname + imagesDir);
	//int count = 0;
	let deleteQuery = {
        Objects: [
            /*{Key: 'a.txt'},
            {Key: 'b.txt'},
            {Key: 'c.txt'}*/
        ]
    }
	let count = 0;
    for (const file of files) {
      const file_with_path = path.join(__dirname + imagesDir, file);
      const file_status = await fs.promises.stat(file_with_path);
	  //console.log(file);
      if (file_status.isFile()) {
        //console.log("'%s'  file.", file);
		//delete file from AWS origin to save space
		//deleteQuery.Objects.push({'Key': file});
		await deleteFileAWS(file);
		count +=1;
      } 
	  /*else if (stat.isDirectory()) {
        console.log("'%s' directory.", fromPath);
      }*/
    }
	
	res.send({status: 'success', count: count});
	//bulk delete option. Avoid for now
	/*
	console.log(deleteQuery);
	let deleteParam = {
		Bucket: 'actifit',
		Delete: deleteQuery
	}
	console.log(deleteParam);
	
	s3.deleteObjects(deleteParam, function(err, data) {
		if (err) console.log(err, err.stack);
		else console.log('delete', data);
	});*/
})

/*
async function deleteFileAWS(fileName){
	console.log('deleting '+fileName);
	let aws_params = {
		Bucket: "actifit", 
		Key: fileName
	};
	let outc = await s3.deleteObject(aws_params).promise();
	//console.log(outc);
	console.log('done');
}*/

app.get('/:imgParam', async function (req, res){
	console.log(req.params.imgParam);
	console.log('fetching image');
	//check if image exists locally, if not, fetch from AWS, compress, and store locally
	if (fs.existsSync(__dirname + imagesDir +req.params.imgParam)) {
		console.log('file exists');
		res.type('png');
		res.sendFile(__dirname + imagesDir + req.params.imgParam);
		return;
	}else if (fs.existsSync(extraStoragePath + imagesDir +req.params.imgParam)){
		//check in alternate location
		console.log('file exists in extra storage');
		res.type('png');
		res.sendFile(extraStoragePath + imagesDir + req.params.imgParam);
		return;		
	}else{
		res.send({error:'no match'});
		return;
	}
	/*else{
		//attempt to grab image from AWS

		const url = awsLink + req.params.imgParam;
		const target_image_path = __dirname + imagesDir + req.params.imgParam;
		
		axios({
			url,
			//responseType: 'stream',
			responseType: 'arraybuffer',
			//httpsAgent: new https.Agent({ keepAlive: true }),
			//timeout: 30000
		  }).then(
			(response) =>
			{
				console.log(target_image_path);
				sharp(response.data)
				//.png({compressionLevel: 8})
				.jpeg({quality: 50})
				.rotate()
				.toFile(target_image_path)
				.then(() => {
					console.log(`Image downloaded and resized!`)
					res.type('png');
					res.sendFile(target_image_path);
					
					//also delete image from AWS
					deleteFileAWS(req.params.imgParam);
				})
				.catch(() => {
					console.log('error');
					res.send({error:''});
				})
				
				
				
			}
			 
		  ).catch(
			e => {
				console.log(e.code)
				res.send({error:''});
			});
		
	
	}*/

})


app.listen(PORT);
console.log('Server started on port '+PORT);
