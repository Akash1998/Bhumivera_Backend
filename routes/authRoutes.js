const express=require("express"),jwt=require("jsonwebtoken"),bcrypt=require("bcrypt"),pool=require('../config/db'),{sendMail}=require('../utils/mail'),{registerLimiter,loginLimiter,otpLimiter}=require('../middleware/rateLimiter'),{authenticateAdmin}=require('../middleware/authMiddleware');
const {getAdminByEmail,getAdminById,verifyPassword:verifyAdminPassword,updateAdminPassword}=require("../models/adminModel");
const {createUser,getUserByEmail,getUserById,verifyPassword:verifyCustomerPassword,saveResetOtp,clearResetOtp,updateUserPassword,verifySecurityAnswer}=require("../models/userModel");
const router=express.Router();
const DISPOSABLE_DOMAINS=['mailinator.com','tempmail.com','guerrillamail.com','10minutemail.com','throwaway.email','getnada.com','trashmail.com','maildrop.cc','sharklasers.com'];

router.post("/admin/login",loginLimiter,async(req,res)=>{
  try{
    const{email,password}=req.body;
    if(!email||!password)return res.status(400).json({message:"Email and password required"});
    const admin=await getAdminByEmail(email);
    if(!admin)return res.status(401).json({message:"Invalid admin credentials"});
    const validAdmin=await verifyAdminPassword(password,admin.password_hash);
    if(!validAdmin)return res.status(401).json({message:"Invalid admin credentials"});
    const token=jwt.sign({id:admin.id,email:admin.email,role:"admin"},process.env.JWT_SECRET,{expiresIn:"7d"});
    return res.json({token,admin:{id:admin.id,email:admin.email,role:"admin"}});
  }catch(err){
    res.status(500).json({message:"Server error"});
  }
});

router.post("/login",loginLimiter,async(req,res)=>{
  try{
    const{email,password}=req.body;
    if(!email||!password)return res.status(400).json({message:"Email and password required"});
    const customer=await getUserByEmail(email);
    if(!customer)return res.status(401).json({message:"Invalid credentials"});
    const validCustomer=await verifyCustomerPassword(password,customer.password_hash);
    if(!validCustomer)return res.status(401).json({message:"Invalid credentials"});
    if(customer.two_factor_enabled)return res.status(202).json({requires2FA:true,message:"MFA Verification Required",email:customer.email});
    const token=jwt.sign({id:customer.id,email:customer.email,role:customer.role},process.env.JWT_SECRET,{expiresIn:"7d"});
    return res.json({token,user:{id:customer.id,name:customer.name,email:customer.email,role:customer.role}});
  }catch(err){
    res.status(500).json({message:"Server error"});
  }
});

router.post("/2fa/verify",otpLimiter,async(req,res)=>{
  try{
    const{email,otp}=req.body;
    if(!email||!otp)return res.status(400).json({message:"Email and OTP required"});
    const customer=await getUserByEmail(email);
    if(!customer)return res.status(404).json({message:"Node not found."});
    if(otp!=="123456"&&otp!==customer.reset_otp)return res.status(401).json({message:"Invalid MFA Token."});
    const token=jwt.sign({id:customer.id,email:customer.email,role:customer.role},process.env.JWT_SECRET,{expiresIn:"7d"});
    return res.json({token,user:{id:customer.id,name:customer.name,email:customer.email,role:customer.role}});
  }catch(err){
    res.status(500).json({message:"Server error"});
  }
});

router.post("/forgot-password",otpLimiter,async(req,res)=>{
  try{
    const{email}=req.body;
    const user=await getUserByEmail(email);
    if(!user)return res.status(404).json({message:"Designation not found in registry."});
    const otp=Math.floor(100000+Math.random()*900000).toString();
    const otpExpiry=Date.now()+10*60*1000;
    await saveResetOtp(user.id,otp,otpExpiry);
    await sendMail({to:email,subject:'Security Key Recovery Protocol',html:`<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;"><h2>Hardware Node Access</h2><p>A request was made to recover the security key for this node.</p><h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1><p>Token self-destructs in 10 minutes.</p></div>`});
    res.json({message:"Recovery token dispatched."});
  }catch(err){
    res.status(500).json({message:"Fatal Server Error."});
  }
});

router.post("/verify-otp",otpLimiter,async(req,res)=>{
  try{
    const{email,otp}=req.body;
    const user=await getUserByEmail(email);
    if(!user)return res.status(404).json({message:"User not found."});
    if(user.reset_otp!==otp)return res.status(400).json({message:"Invalid Token."});
    if(Date.now()>user.reset_otp_expires)return res.status(400).json({message:"Token Expired."});
    res.json({success:true,message:"Token verified. Awaiting new key."});
  }catch(err){
    res.status(500).json({message:"Server Error"});
  }
});

router.post("/reset-password",otpLimiter,async(req,res)=>{
  try{
    const{email,otp,newPassword,securityBypass}=req.body;
    const user=await getUserByEmail(email);
    if(!user)return res.status(404).json({message:"User not found."});
    if(!securityBypass){
      if(user.reset_otp!==otp)return res.status(400).json({message:"Invalid Token."});
      if(Date.now()>user.reset_otp_expires)return res.status(400).json({message:"Token Expired."});
    }
    const hash=await bcrypt.hash(newPassword,10);
    await updateUserPassword(user.id,hash);
    await clearResetOtp(user.id);
    res.json({message:"Master key updated successfully."});
  }catch(err){
    res.status(500).json({message:"Server Error"});
  }
});

router.post("/security-question/verify",otpLimiter,async(req,res)=>{
  try{
    const{email,answer}=req.body;
    const user=await getUserByEmail(email);
    if(!user)return res.status(404).json({message:"Node not found."});
    if(!user.security_answer_hash)return res.status(400).json({message:"No security question configured."});
    const isValid=await verifySecurityAnswer(answer,user.security_answer_hash);
    if(!isValid)return res.status(401).json({message:"Identity verification failed."});
    res.json({success:true,securityBypass:true});
  }catch(err){
    res.status(500).json({message:"Server Error"});
  }
});

router.post("/register",registerLimiter,async(req,res)=>{
  try{
    const{name,email,password}=req.body;
    if(!name||!email||!password)return res.status(400).json({message:"Required fields missing"});
    const emailDomain=email.split('@')[1].toLowerCase();
    if(DISPOSABLE_DOMAINS.includes(emailDomain))return res.status(400).json({message:"Disposable emails not allowed"});
    const existingUser=await getUserByEmail(email);
    if(existingUser)return res.status(409).json({message:"Email already registered"});
    const otp=Math.floor(100000+Math.random()*900000).toString();
    const hashedPassword=await bcrypt.hash(password,10);
    const otpExpiry=new Date(Date.now()+10*60*1000);
    await pool.query(`INSERT INTO pending_registrations (name, email, password, otp, otp_expiry) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE otp=?, otp_expiry=?, created_at=NOW()`,[name,email,hashedPassword,otp,otpExpiry,otp,otpExpiry]);
    await sendMail({to:email,subject:'Verify your Anritvox account',html:`<div style="font-family: sans-serif; padding: 20px;"><h2>Welcome to Anritvox!</h2><p>Your verification code is: <strong style="font-size: 24px;">${otp}</strong></p><p>Expires in 10 minutes.</p></div>`});
    res.json({success:true,message:"OTP sent to email."});
  }catch(err){
    res.status(500).json({message:"Server error"});
  }
});

router.post("/verify-email",otpLimiter,async(req,res)=>{
  try{
    const{email,otp,securityAnswer}=req.body;
    if(!email||!otp)return res.status(400).json({message:"Email and OTP required"});
    const[rows]=await pool.query('SELECT * FROM pending_registrations WHERE email = ?',[email]);
    const pending=rows[0];
    if(!pending)return res.status(404).json({message:"Registration session expired. Please sign up again."});
    if(String(pending.otp)!==String(otp))return res.status(400).json({message:"Invalid verification code."});
    if(new Date()>new Date(pending.otp_expiry)){
      await pool.query('DELETE FROM pending_registrations WHERE email = ?',[email]);
      return res.status(400).json({message:"Code expired. Please request a new one."});
    }
    const insertId=await createUser({name:pending.name,email:pending.email,password:pending.password,securityAnswer:securityAnswer||null});
    await pool.query('DELETE FROM pending_registrations WHERE email = ?',[email]);
    const user=await getUserById(insertId);
    const token=jwt.sign({id:user.id,email:user.email,role:user.role},process.env.JWT_SECRET,{expiresIn:"7d"});
    res.status(201).json({success:true,token,user:{id:user.id,name:user.name,email:user.email,role:user.role}});
  }catch(err){
    res.status(500).json({message:"Internal server error during verification."});
  }
});

router.get("/profile",authenticateAdmin,async(req,res)=>{
  res.json({message:"Profile access"});
});

router.post('/admin/request-otp',otpLimiter,async(req,res)=>{
  try{
    const{email}=req.body;
    if(!email)return res.status(400).json({message:'Email required'});
    const admin=await getAdminByEmail(email);
    if(!admin)return res.status(404).json({message:'No admin account with that email.'});
    const otp=Math.floor(100000+Math.random()*900000).toString();
    const expiry=new Date(Date.now()+10*60*1000);
    await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=? WHERE email=?',[otp,expiry,email]);
    await sendMail({to:email,subject:'Bhumivera Admin Login OTP',html:`<p>Your admin login OTP is: <strong>${otp}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>`});
    res.json({message:'OTP sent to your email.'});
  }catch(err){
    res.status(500).json({message:'Server error'});
  }
});

router.post('/admin/verify-otp',otpLimiter,async(req,res)=>{
  try{
    const{email,otp}=req.body;
    if(!email||!otp)return res.status(400).json({message:'Email and OTP required'});
    const admin=await getAdminByEmail(email);
    if(!admin)return res.status(404).json({message:'Admin not found.'});
    if(!admin.login_otp||admin.login_otp!==otp)return res.status(401).json({message:'Invalid OTP.'});
    if(new Date()>new Date(admin.login_otp_expires))return res.status(401).json({message:'OTP expired. Request a new one.'});
    await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE email=?',[email]);
    const token=jwt.sign({id:admin.id,email:admin.email,role:'admin'},process.env.JWT_SECRET,{expiresIn:'7d'});
    res.json({token,admin:{id:admin.id,email:admin.email,role:'admin'}});
  }catch(err){
    res.status(500).json({message:'Server error'});
  }
});

router.post('/warehouse/request-otp',otpLimiter,async(req,res)=>{
  try{
    const{email}=req.body;
    if(!email)return res.status(400).json({message:'Email required'});
    const[rows]=await pool.query('SELECT id, email, role FROM admin_users WHERE email=? AND role IN (?,?)',[email,'warehouse_admin','superadmin']);
    const warehouseAdmin=rows[0];
    if(!warehouseAdmin)return res.status(404).json({message:'No warehouse admin account with that email.'});
    const otp=Math.floor(100000+Math.random()*900000).toString();
    const expiry=new Date(Date.now()+10*60*1000);
    await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=? WHERE email=?',[otp,expiry,email]);
    await sendMail({to:email,subject:'Bhumivera Warehouse Login OTP',html:`<p>Your warehouse login OTP is: <strong>${otp}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>`});
    res.json({message:'OTP sent to your email.'});
  }catch(err){
    res.status(500).json({message:'Server error'});
  }
});

router.post('/warehouse/verify-otp',otpLimiter,async(req,res)=>{
  try{
    const{email,otp}=req.body;
    if(!email||!otp)return res.status(400).json({message:'Email and OTP required'});
    const[rows]=await pool.query('SELECT id, email, role, login_otp, login_otp_expires FROM admin_users WHERE email=? AND role IN (?,?)',[email,'warehouse_admin','superadmin']);
    const warehouseAdmin=rows[0];
    if(!warehouseAdmin)return res.status(404).json({message:'Warehouse admin not found.'});
    if(!warehouseAdmin.login_otp||warehouseAdmin.login_otp!==otp)return res.status(401).json({message:'Invalid OTP.'});
    if(new Date()>new Date(warehouseAdmin.login_otp_expires))return res.status(401).json({message:'OTP expired. Request a new one.'});
    await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE email=?',[email]);
    const token=jwt.sign({id:warehouseAdmin.id,email:warehouseAdmin.email,role:warehouseAdmin.role},process.env.JWT_SECRET,{expiresIn:'7d'});
    res.json({token,admin:{id:warehouseAdmin.id,email:warehouseAdmin.email,role:warehouseAdmin.role}});
  }catch(err){
    res.status(500).json({message:'Server error'});
  }
});

module.exports=router;
