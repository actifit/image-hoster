const express = require('express');

//to reactivate import mode, adjust package.json to include under main node:
//"type": "module", 

const fetch = require('node-fetch');
//var Request = require("request");

const axios = require('axios');
const sharp = require('sharp');

const PORT = process.env.PORT || 80
const version = 0.1

const fs = require("fs"); // Or `import fs from "fs";` with ESM
const path = require('path');
const S3 = require('aws-sdk').S3;


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
//console.log(config.AWS_ACCESS_KEY_ID);
//console.log(config.AWS_SECRET_ACCESS_KEY);
let s3 = new S3({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    //region: config.AWS_REGION
});

async function fetchMeta(imgParam){
	let input = 'loadedimgs/'+imgParam;
	const metadata = await sharp(input).metadata();
	console.log(metadata);
	let inst = sharp('loadedimgs/'+imgParam).rotate().toFile('loadedimgs/'+imgParam+'_fixed');
	return;
}


function verifySecretKey(req, res, next) {
  const token = req.headers['authorization'];

  if (token !== secretKey) {
    return res.status(403).send('Unauthorized access. Invalid token.');
  }

  next();
}


app.get('/', async function (req,res){
	res.send('EHLO');
})

app.post('/upload', verifySecretKey, upload.single('image'), function (req, res) { 
	try { 
		// File information available at req.file 
		console.log(req.file); 
		// Send response back to client 
		res.status(200).send('Image uploaded successfully!'); 
	} catch (err) { 
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

async function deleteFileAWS(fileName){
	console.log('deleting '+fileName);
	let aws_params = {
		Bucket: "actifit", 
		Key: fileName
	};
	let outc = await s3.deleteObject(aws_params).promise();
	//console.log(outc);
	console.log('done');
}

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
		
	
	}

})


app.listen(PORT);
console.log('Server started on port '+PORT);
