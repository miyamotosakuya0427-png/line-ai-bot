"use strict";
const crypto=require("node:crypto");
const {stable}=require("./market-data-normalizer");
function hashEvent(event,previousHash=null){if(!event||typeof event!=="object")throw new Error("event required");const canonical=stable({event,previousHash});return crypto.createHash("sha256").update(canonical).digest("hex");}
function verifyChain(events){let previous=null;for(let i=0;i<events.length;i++){const e=events[i];if(e.previousHash!==previous||hashEvent(e.payload,previous)!==e.eventHash)return {valid:false,index:i};previous=e.eventHash;}return {valid:true,count:events.length,headHash:previous};}
module.exports={hashEvent,verifyChain};