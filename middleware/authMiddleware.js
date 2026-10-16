const jwt=require('jsonwebtoken');
const { isSessionActive } = require('../utils/sessionStore');

const ROLE_PERMISSIONS = Object.freeze({
  superadmin: new Set(['*']),
  admin: new Set([
    'admin.access', 'profile.read', 'profile.security.update', 'analytics.read',
    'users.read',
    'orders.read', 'orders.fulfill', 'orders.manage', 'orders.refund',
    'products.manage', 'categories.manage', 'inventory.read', 'inventory.update',
    'shipping.manage', 'shipping.labels.read', 'shipping.labels.create',
    'shipping.providers.manage', 'returns.manage', 'support.manage',
    'accounting.read', 'accounting.manage', 'gst.issue', 'marketing.manage',
    'settings.manage', 'impact.manage', 'reviews.manage', 'coupons.manage',
    'notifications.manage', 'logs.read', 'warehouse.operations', 'serials.manage',
    'affiliate.manage', 'tax.manage', 'wallet.manage', 'warranty.manage',
    'gamification.manage', 'ai.generate', 'search.manage',
  ]),
  warehouse_admin: new Set([
    'inventory.read', 'inventory.update', 'orders.fulfill',
    'shipping.labels.read', 'shipping.labels.create', 'warehouse.operations',
  ]),
});

const ADMIN_PERMISSION_ROUTES = [
  { pattern: /^\/api\/auth\/profile$/, permission: 'profile.read' },
  { pattern: /^\/api\/auth\/admin\/change-password$/, permission: 'profile.security.update' },
  { pattern: /^\/api\/admin\/users\/(?:notifications|email-campaigns)$/, permission: 'marketing.manage' },
  { pattern: /^\/api\/admin\/users\/[^/]+\/reset-password$/, permission: 'support.manage', methods: ['POST'] },
  { pattern: /^\/api\/admin\/users(?:\/[^/]+)?(?:\/orders)?$/, permission: 'users.read', methods: ['GET'] },
  { pattern: /^\/api\/admin\/users(?:\/|$)/, permission: 'users.manage' },
  { pattern: /^\/api\/admin\/orders(?:\/export\/csv)?$/, permission: 'orders.read', methods: ['GET'] },
  { pattern: /^\/api\/admin\/orders\/[^/]+\/status$/, permission: 'orders.fulfill', methods: ['PUT'] },
  { pattern: /^\/api\/admin\/orders(?:\/|$)/, permission: 'orders.manage' },
  { pattern: /^\/api\/warehouse\/admin(?:\/|$)/, permission: 'users.manage' },
  { pattern: /^\/api\/orders\/all$/, permission: 'orders.read' },
  { pattern: /^\/api\/orders\/[^/]+\/status$/, permission: 'orders.fulfill', methods: ['PUT'] },
  { pattern: /^\/api\/orders(?:\/|$)/, permission: 'orders.manage' },
  { pattern: /^\/api\/inventory(?:\/|$)/, permission: 'inventory.read', methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/inventory(?:\/|$)/, permission: 'inventory.update' },
  { pattern: /^\/api\/shipping\/carriers\/[^/]+\/test$/, permission: 'shipping.providers.manage' },
  { pattern: /^\/api\/shipping\/carriers(?:\/|$)/, permission: 'shipping.providers.manage', methods: ['PUT'] },
  { pattern: /^\/api\/shipping\/carriers(?:\/|$)/, permission: 'shipping.labels.read' },
  { pattern: /^\/api\/shipping\/labels\/?$/, permission: 'shipping.labels.read', methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/shipping\/labels\/?$/, permission: 'shipping.labels.create', methods: ['POST'] },
  { pattern: /^\/api\/shipping\/labels\/[^/]+\/file$/, permission: 'shipping.labels.read' },
  { pattern: /^\/api\/shipping\/labels(?:\/|$)/, permission: 'shipping.labels.create' },
  { pattern: /^\/api\/shipping\/zones(?:\/|$)/, permission: 'shipping.manage' },
  { pattern: /^\/api\/gst(?:\/|$)/, permission: 'accounting.read', methods: ['GET', 'HEAD'] },
  { pattern: /^\/api\/gst(?:\/|$)/, permission: 'gst.issue' },
  { pattern: /^\/api\/analytics(?:\/|$)/, permission: 'analytics.read' },
  { pattern: /^\/api\/products(?:\/|$)/, permission: 'products.manage' },
  { pattern: /^\/api\/categories(?:\/|$)/, permission: 'categories.manage' },
  { pattern: /^\/api\/subcategories(?:\/|$)/, permission: 'categories.manage' },
  { pattern: /^\/api\/returns\/admin\/[^/]+\/refund(?:\/reconcile)?$/, permission: 'orders.refund', methods: ['POST'] },
  { pattern: /^\/api\/returns\/admin(?:\/|$)/, permission: 'returns.manage' },
  { pattern: /^\/api\/returns(?:\/|$)/, permission: 'returns.manage', methods: ['PUT', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/contact(?:\/|$)/, permission: 'support.manage' },
  { pattern: /^\/api\/coupons(?:\/|$)/, permission: 'coupons.manage' },
  { pattern: /^\/api\/flash-sales(?:\/|$)/, permission: 'marketing.manage' },
  { pattern: /^\/api\/impact\/admin(?:\/|$)/, permission: 'impact.manage' },
  { pattern: /^\/api\/reviews(?:\/|$)/, permission: 'reviews.manage', methods: ['GET'] },
  { pattern: /^\/api\/notifications\/admin(?:\/|$)/, permission: 'notifications.manage' },
  { pattern: /^\/api\/logs(?:\/|$)/, permission: 'logs.read' },
  { pattern: /^\/api\/serials\/admin(?:\/|$)/, permission: 'serials.manage' },
  { pattern: /^\/api\/serials(?:\/|$)/, permission: 'serials.manage', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/settings(?:\/|$)/, permission: 'settings.manage' },
  { pattern: /^\/api\/affiliate(?:\/|$)/, permission: 'affiliate.manage' },
  { pattern: /^\/api\/tax(?:\/|$)/, permission: 'tax.manage' },
  { pattern: /^\/api\/wallet(?:\/|$)/, permission: 'wallet.manage' },
  { pattern: /^\/api\/warranty(?:\/|$)/, permission: 'warranty.manage', methods: ['GET'] },
  { pattern: /^\/api\/gamification(?:\/|$)/, permission: 'gamification.manage' },
  { pattern: /^\/api\/ai(?:\/|$)/, permission: 'ai.generate' },
  { pattern: /^\/api\/search(?:\/|$)/, permission: 'search.manage' },
];

const getAdminPermission = req => {
  const routePath = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/{2,}/g, '/');
  const method = String(req.method || 'GET').toUpperCase();
  const rule = ADMIN_PERMISSION_ROUTES.find(candidate =>
    candidate.pattern.test(routePath) && (!candidate.methods || candidate.methods.includes(method))
  );
  return rule?.permission || 'admin.access';
};

const hasPermission = (role, permission) => {
  const permissions = ROLE_PERMISSIONS[role];
  return Boolean(permissions && (permissions.has('*') || permissions.has(permission)));
};

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
  if(!ROLE_PERMISSIONS[payload.role])
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
  const permission = getAdminPermission(req);
  if (!hasPermission(payload.role, permission)) {
    console.warn('[AUTHORIZATION_DENIED]', JSON.stringify({
      role: payload.role,
      permission,
      method: req.method,
      path: `${req.baseUrl || ''}${req.path || ''}`,
    }));
    return res.status(403).json({
      code: 'AUTH_PERMISSION_DENIED',
      message: 'You do not have permission to perform this action.',
      permission,
    });
  }
  const routePath = `${req.baseUrl || ''}${req.path || ''}`;
  if (
    !hasPermission(payload.role, 'orders.refund') &&
    req.method === 'PUT' &&
    /^\/api\/returns\/admin\/[^/]+$/.test(routePath) &&
    String(req.body?.status || '').toLowerCase() === 'refunded'
  ) {
    return res.status(403).json({
      code: 'AUTH_PERMISSION_DENIED',
      message: 'Issuing a return refund requires the refund permission.',
      permission: 'orders.refund',
    });
  }
  if (payload.role === 'warehouse_admin' &&
      permission === 'orders.fulfill' &&
      !['packed', 'shipped', 'delivered'].includes(String(req.body?.status || '').toLowerCase())) {
    return res.status(403).json({
      code: 'AUTH_PERMISSION_DENIED',
      message: 'Warehouse accounts may only mark orders packed, shipped, or delivered.',
      permission: 'orders.fulfill',
    });
  }
  req.admin={id:payload.id,email:payload.email,role:payload.role};
  req.user=payload;
  req.permission=permission;
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

const optionalAuth=async(req,res,next)=>{
  req.user=null;
  const auth=req.headers.authorization;
  if(!auth||!auth.startsWith('Bearer ')) return next();

  let payload;
  try {
    payload=jwt.verify(auth.slice(7).trim(),process.env.JWT_SECRET||'fallback_secret');
  } catch {
    return next();
  }
  if(!payload?.id) return next();

  try {
    if(!await isSessionActive(payload,req)) return next();
  } catch(err) {
    console.error('[AUTH_SESSION_CHECK_ERROR]:',err);
    return res.status(503).json({message:'Could not validate session. Please try again.'});
  }

  if(payload.role!=='admin'&&payload.role!=='superadmin'){
    const pool=require('../config/db');
    try {
      const[userData]=await pool.query('SELECT is_active FROM users WHERE id=?',[payload.id]);
      if(!userData||userData.length===0||parseInt(userData[0].is_active)===0) return next();
    } catch(dbErr) {
      if(dbErr.code!=='ER_BAD_FIELD_ERROR') {
        console.error('[AUTH_DB_ERROR]:',dbErr);
        return res.status(500).json({message:'Internal server error during session validation.'});
      }
    }
  }

  req.user=payload;
  return next();
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

module.exports={authenticateAdmin,authenticateUser,optionalAuth,isAdmin,isWarehouseAdmin,ROLE_PERMISSIONS,getAdminPermission,hasPermission};
