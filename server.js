const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({limit:'1mb'}));
app.use(express.static(__dirname));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'italian-booking'}));
app.get('*splat',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`Italian booking site running on port ${PORT}`));
