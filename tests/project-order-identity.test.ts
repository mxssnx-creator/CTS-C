import assert from "node:assert/strict";
import {test} from "node:test";
import {stableClientOrderId,isOwnedClientOrderId,protectionOrders} from "../core/bingx";
test("CTS-C stable order and protection identities exclude all sibling projects",()=>{
 const id=stableClientOrderId("bingx-x02","full-config:lane:entry:1");assert.equal(id,stableClientOrderId("bingx-x02","full-config:lane:entry:1"));assert.notEqual(id,stableClientOrderId("bingx-x01","full-config:lane:entry:1"));assert.notEqual(id,stableClientOrderId("bingx-x02","other-config:lane:entry:1"));assert.equal(isOwnedClientOrderId(id),true);
 const controls=protectionOrders({symbol:"BTC-USDT",direction:"LONG",quantity:".01",clientOrderId:id,stopLoss:90,takeProfit:110});assert.equal(new Set([id,...controls.map(x=>x.clientOrderId)]).size,3);assert.ok(controls.every(x=>isOwnedClientOrderId(x.clientOrderId)));
 for(const other of ["CTSAV2_E1","CTSBV2_E1","CTSXV2_E1","Gx02abc","knabc123entry","ktabc123mentry"])assert.equal(isOwnedClientOrderId(other),false);
});
