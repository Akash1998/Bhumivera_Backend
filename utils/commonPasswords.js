let _passwords = null;

const buildList = () => {
  if (_passwords) return _passwords;
  const base = [
    'password','123456','123456789','qwerty','12345678','111111','12345','1234567','dragon','123123',
    'baseball','abc123','football','monkey','letmein','shadow','master','666666','qwertyuiop','123321',
    'mustang','1234567890','michael','654321','superman','1qaz2wsx','7777777','fuckyou','121212','000000',
    'qazwsx','123qwe','killer','trustno1','jordan','jennifer','zxcvbnm','asdfgh','hunter','buster',
    'soccer','harley','batman','andrew','tigger','sunshine','iloveyou','fuckme','2000','charlie',
    'robert','thomas','hockey','ranger','daniel','starwars','klaster','112233','george','asshole',
    'computer','michelle','jessica','pepper','1111','zxcvbn','555555','11111111','131313','freedom',
    '777777','pass','fuck','maggie','159753','aaaaa','ginger','princess','joshua','cheese',
    'amanda','summer','love','ashley','696969','nicole','chelsea','biteme','matthew','access',
    'yankees','987654321','dakota','aaaaaaaa','aaaa','password1','vagina','cookie','merlin','dallas',
    '1q2w3e4r','liverpool','anthony','justin','banana','friend','monica','elephant','andy','garfield',
    'charles','decor','unicorn','donald','google','bill1234','steve','hello','mecca','jordan23',
    'london','taylor','snoopy','blue','biteme123','q1w2e3r4','tinker','0987654321','panther','diamond',
    'lauren','angela','rachel','beer','booboo','coffee','scooby','samsung','america','internet',
    'bigdog','fuckoff','sierra','lebron','passw0rd','testing','cocacola','pussy','asdfghjkl','golden',
    'chocolate','michelle1','thunder','madison','morgan','hello123','welcome','shadow1','jason','walter',
    '12341234','australia','102030','12345a','123456a','b123456','a123456','123456b','123456c','abcdef',
    'chicken','letmein1','dragon1','monkey1','baseball1','football1','qwerty1','1qazxsw2','abc12345','welcome1',
    'test123','testing1','charlie1','donald1','matrix1','jessica1','computer1','12345678901','iloveyou1','master1',
    'sunshine1','6969','1990','1991','1992','1993','1994','1995','1996','1997',
    '1998','1999','2000','2001','2002','2003','2004','2005','2006','2007',
    '2008','2009','2010','2011','2012','2013','2014','2015','2016','2017',
    '2018','2019','2020','2021','2022','2023','2024','2025','2026','1q2w3e',
    'zaq12wsx','zaq1xsw2','qwe123','qweasd','qweasdzxc','asdf1234','asdfasdf','asdf','zxcv','123abc',
    'admin','toor','root','guest','user','test','info','support','service','system',
    'login','password!','P@ssw0rd','password123','password12','password11','password9','password8','password7','password6',
    'password5','password4','password3','password2','p@ssword','p@$$w0rd','passw0rd','pass123','password1234','password0',
    'changeme','default','temp123','demo123','client','backup','linux','unix','mac','windows',
    'server','database','oracle','postgres','mysql','ftp','tomcat','apache','jboss','weblogic',
    'websphere','coldfusion','wordpress','joomla','drupal','magento','shopify','prestashop','opencart','woocommerce',
    'admin123','toor123','root123','guest123','user123','test1234','letmein123','welcome123','changeme123','default123',
    'temp','demo','sample','example','testtest','passpass','login123','register','signup','signin',
    'facebook','twitter','instagram','linkedin','youtube','google1','apple1','amazon1','netflix','spotify',
    'paypal1','dropbox','github','gitlab','bitbucket','stackoverflow','reddit','pinterest','tumblr','snapchat',
    'tiktok','whatsapp','telegram','discord','slack','notion','figma','canva','zoom1','skype1',
    'football2','baseball2','basketball','hockey1','soccer1','tennis1','cricket1','rugby1','golf1','swimming',
    'summer1','winter1','autumn1','spring1','monday1','tuesday1','wednesday1','thursday1','friday1','saturday1',
    'sunday1','january1','february1','march1','april1','june1','july1','august1','september1','october1',
    'november1','december1','monday','tuesday','wednesday','thursday','friday','saturday','sunday',
    'january','february','march','april','may','june','july','august','september','october',
    'november','december','startrek','starwars','marvel1','dc1','avengers','ironman','spiderman','batman1',
    'superman1','deadpool','wolverine','xmen1','justice','harrypotter','lotr1','hobbit','gandalf','frodo',
    'matrix','terminator','aliens','predator','jaws','rocky','rambo','scarface','godfather','goodfellas',
    'pulp','fiction','forrest','gump','shawshank','inception','interstellar','gladiator','braveheart','beautiful',
    'mind','fight','club','se7en','silence','lambs','casablanca','citizen','kane','psycho',
    'vertigo','rear','window','metropolis','modern','times','great','escape','shawshank','redemption','green',
    'mile','schindler','list','departed','noir','gone','girl','dragon','tattoo','social',
    'network','room','cinderella','aladdin','mulan','moana','elsa','anna','belle','ariel',
    'jasmine','tiana','rapunzel','merida','pocahontas','mowgli','simba','nala','scar','mufasa',
    'trump1','biden1','obama1','clinton1','bush1','reagan1','lincoln1','washington1','churchill1','stalin1',
    'putin1','xi1','modi1','zelensky1','macron1','merkel1','johnson1','trudeau1','morrison1','netanyahu1',
    'asshole1','bitch','dick','cunt','fucker','motherfucker','bullshit','horseshit','crap123','dammit',
    'gandhi1','mandela1','queen1','king1','prince1','princess1','duke1','earl1','lord1','lady1',
    'jedi1','sith1','republic1','empire1','rebels1','rogue1','phantom','menace','clones','revenge',
    'sith','empire','strikes','back','return','jedi','force','awakens','last','jedi',
    'rise','skywalker','rogue','one','solo','phantom','menace','attack','clones','revenge',
    'sith','order','return','jedi','force','luke','leia','han','chewie','lando',
    'rey','finn','poe','kylo','ren','bb8','r2d2','c3po','darth','vader',
    'maul','sidious','palpatine','yoda','obi','wan','kenobi','anakin','padme','windu',
    'jar','binks','grievous','dooku','jango','boba','fett','lando','calrissian','jabba',
    'hutt','wampa','tauntaun','ewok','mon','mothma','ackbar','lando','chewbacca','millennium',
    'falcon','xwing','tie','fighter','star','destroyer','death','star','galactic','senate',
    'rebel','alliance','trade','federation','separatist','confederacy','independent','systems','council','jedi',
    'temple','coruscant','tatooine','naboo','alderaan','hoth','endor','dagobah','bespin','cloud',
    'city','mos','eisley','cantina','jawa','sandpeople','tusken','raiders','sarlacc','krayt',
    'dragon','lars','beru','owen','biggs','wedge','antilles','porkins','red','leader',
    'gold','leader','green','leader','yavin','battle','yavin','massassi','outpost','base',
    'echo','base','hoth','generator','shield','door','asteroid','field','bespin','carbonite',
    'solo','carbon','frozen','bounty','hunter','bossk','ig88','dengar','zuckuss','4lom',
    'lando','betrayal','luke','skywalker','hand','cut','off','vader','reveal','father',
    'nooooo','luke','training','yoda','dagobah','jedi','training','force','ghosts','ben'
  ];
  const permutations = new Set(base);
  const suffixes = ['', '1', '12', '123', '1234', '12345', '123456', '!', '@', '#', '$', '%', '?', '*', '.', '-', '_', '1!', '@123', '#1', '2024', '2025', '2026', '01', '02', '03', '99', '00', '11', '22', '33'];
  for (const w of base) for (const s of suffixes) if (w && s) permutations.add(w + s);
  _passwords = new Set(Array.from(permutations).map(p => String(p).toLowerCase().trim()));
  return _passwords;
};

const COMMON_PASSWORDS = buildList();

const isCommonPassword = (pw) => {
  if (!pw) return false;
  return COMMON_PASSWORDS.has(String(pw).toLowerCase().trim());
};

module.exports = { COMMON_PASSWORDS, isCommonPassword };
