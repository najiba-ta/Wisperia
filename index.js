const dns = require('node:dns');
dns.setServers(['1.1.1.1', '1.0.0.1']); 

const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  }),
);
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("wisperia");
    const subscriptionsCollection = db.collection('subscriptions');
    const userCollection = db.collection('user');
    const lessonCollection = db.collection('lesson');

    app.post('/subscriptions',async (req,res)=>{
      const {sessionId,userId,priceId,userEmail} = req.body
      const isExist = await subscriptionsCollection.findOne({sessionId})
      if(isExist){
        return res.json("Already Exist")
      }
      const result =await subscriptionsCollection.insertOne({
        sessionId,
        userEmail,
        userId,
        priceId
      })
      console.log(userId);
      // update user role
     const userRes = await userCollection.updateOne(
        {_id: new ObjectId(userId)},
        {$set:{plan:"premium"}}
    );
    console.log(userRes);
     res.json({msg:"Payment Successful!"})
    })

    app.post('/user/add-lesson',async (req,res)=>{
      const data = req.body
      const result = await lessonCollection.insertOne(data);
      res.send(result)
    })
 

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
