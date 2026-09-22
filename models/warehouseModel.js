const pool = require('../config/db');

const initWarehouseTables = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS warehouse_access (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                granted_by INT,
                store_name VARCHAR(255),
                is_active TINYINT(1) DEFAULT 1,
                granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS warehouse_user_states (
                user_id INT PRIMARY KEY,
                app_state JSON,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS warehouse_sales_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                store_name VARCHAR(255),
                product_name VARCHAR(255),
                quantity INT,
                sale_price DECIMAL(10,2),
                customer_type ENUM('registered','walkin') DEFAULT 'registered',
                customer_name VARCHAR(255),
                legacy_id VARCHAR(50) DEFAULT NULL,
                sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('Error initializing warehouse tables:', err);
    }
};
const restoreLegacyBackup=async(d,uid,sn)=>{const c=await pool.getConnection();try{await c.beginTransaction();const cm=new Map(d.c.map(x=>[x.id,x.n]));for(let s of d.s){const cn=cm.get(s.cust?.id)||'Walk-in';for(let i of(s.items||[])){await c.query(`INSERT INTO warehouse_sales_log (user_id,store_name,product_name,quantity,sale_price,customer_type,customer_name,legacy_id,sold_at) VALUES (?,?,?,?,?,?,?,?,?)`,[uid,sn,i.n||'Legacy Item',i.q||1,i.pr||0,'walkin',cn,s.id,new Date(s.date||Date.now())])}}await c.commit();return!0}catch(e){await c.rollback();throw e}finally{c.release()}};
const logWalkinSale=async(d)=>{const{uid,sn,p,q,pr}=d;const[r]=await pool.query(`INSERT INTO warehouse_sales_log (user_id,store_name,product_name,quantity,sale_price,customer_type,customer_name) VALUES (?,?,?,?,?,?,?)`,[uid,sn,p,q,pr,'walkin','Walk-in Customer']);return r.insertId};
module.exports = {
    initWarehouseTables,
    restoreLegacyBackup,
    logWalkinSale
};
