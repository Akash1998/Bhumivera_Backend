const jwt=require('jsonwebtoken');
const { isSessionActive } = require('../utils/sessionStore');

const authenticateAdmin=async(req,res,next)=>{
  const auth=req.headers.authorization;
  if(!auth||!auth.startsWith('Bearer '))
    return res.status(401).json({code:'AUTH_TOKEN_MISSING',message:'Sign in to continue.'});
  let payload;
  try {
    payload = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'fallback_secret');
  } catch (err) {
    return res.status(401).json({code:'AUTH_TOKEN_INVALID',message:'Your admin sign-in has expired. Please sign in again.'});
  }
  if(payload.role!=='admin'&&payload.role!=='superadmin'&&payload.role!=='warehouse_admin')
    return res.status(403).json({message:'Access denied: Admin privileges required.'});
  try {
    if (!await isSessionActive(payload, req)) {
      return res.status(401).json({
        code:'AUTH_SESSION_REAUTH_REQUIRED',
        message:'Your sign-in on this device has expired or needs verification. Please sign in again; other devices are not affected.'
      });
    }
  } catch (err) {
    console.error('[AUTH_SESSION_CHECK_ERROR]:', err);
    return res.status(503).json({message:'Could not validate session. Please try again.'});
  }
  req.admin={id:payload.id,email:payload.email,role:payload.role};
  req.user=payload;
  next();
};

const authenticateUser=async(req,res,next)=>{
  const auth=req.headers.authorization;
  if(!auth||!auth.startsWith('Bearer '))
    return res.status(401).json({code:'AUTH_TOKEN_MISSING',message:'Sign in to continue.'});
  let payload;
  try {
    payload = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'fallback_secret');
  } catch (err) {
    return res.status(401).json({code:'AUTH_TOKEN_INVALID',message:'Your sign-in has expired. Please sign in again.'});
  }
  try {
    if (!await isSessionActive(payload, req)) {
      return res.status(401).json({
        code:'AUTH_SESSION_REAUTH_REQUIRED',
        message:'Your sign-in on this device has expired or needs verification. Please sign in again; other devices are not affected.'
      });
    }
  } catch (err) {
    console.error('[AUTH_SESSION_CHECK_ERROR]:', err);
    return res.status(503).json({message:'Could not validate session. Please try again.'});
  }
  if(payload.role==='admin'||payload.role==='superadmin'){
    req.user=payload;
    return next();
  }
  const pool=require('../config/db');
  try{
    const[userData]=await pool.query('SELECT is_active FROM users WHERE id=?',[payload.id]);
    if(!userData||userData.length===0||parseInt(userData[0].is_active)===0)
      return res.status(401).json({code:'AUTH_ACCOUNT_DISABLED',message:'This account is disabled or no longer available.'})
  }catch(dbErr){
    if(dbErr.code!=='ER_BAD_FIELD_ERROR') {
      console.error("[AUTH_DB_ERROR]:", dbErr);
      return res.status(500).json({ message: "Internal server error during session validation." });
    }
  }
  req.user=payload;
  next();
};

const isAdmin=(req,res,next)=>{
  if(req.user&&(req.user.role==='superadmin'||req.user.role==='admin')) next();
  else res.status(403).json({success:false,message:'Access Denied: Admin Only.'})
};

const isWarehouseAdmin=async(req,res,next)=>{
  if(!req.user) return res.status(401).json({message:'Unauthorized'});
  if(['admin','warehouse_admin','superadmin'].includes(req.user.role)) return next();
  const pool=require('../config/db');
  try{
    const[access]=await pool.query('SELECT is_active FROM warehouse_access WHERE user_id=? AND is_active=1',[req.user.id]);
    if(access.length>0) return next();
    res.status(403).json({success:false,message:'Access Denied: You do not have permission for this. Contact admin.'})
  }catch(e){
    res.status(500).json({message:e.message})
  }
};

module.exports={authenticateAdmin,authenticateUser,isAdmin,isWarehouseAdmin};
