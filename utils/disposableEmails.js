let _domains = null;

const buildList = () => {
  if (_domains) return _domains;
  const base = [
    'mailinator.com','mailinator2.com','mailinator.net','mailinator.org','sogetthis.com','monumentmail.com','notmailinator.com','sendspamhere.com','thisisnotmyrealemail.com','example.com',
    'guerrillamail.com','guerrillamail.net','guerrillamail.org','guerrillamail.biz','guerrillamailblock.com','sharklasers.com','guerrillamail.de','guerrillamail.info','grr.la','guerrillamail.fr',
    'tempmail.com','tempmail.net','tempmail.org','temp-mail.org','temp-mail.ru','temp-mail.io','temp-mail.ir','temp-mail.cn','temp-mail.theypay.me','tempmailaddress.com',
    '10minutemail.com','10minutemail.net','10minutemail.org','10minuteemail.com','10mail.org','10mailbox.com','10x9.com','1secmail.com','1secmail.net','1secmail.org',
    'throwawayemail.com','throwawayemailaddress.com','throwawayemail.org','throwawaymail.com','throwawaymail.net','throwawaymail.org','throwaway.io','throwawaymailaddress.com','throwawayaddress.com','throwaway.email',
    'getnada.com','getnada.net','getnada.org','mailcatch.com','mailcatch.net','mailcatch.org','maildrop.cc','maildrop.cf','maildrop.gq','maildrop.ml',
    'trashmail.com','trashmail.net','trashmail.org','trashmail.io','trashmailer.com','trashmail.ws','trashymail.com','trashymail.net','trashymail.org','trashcanmail.com',
    'nomail2me.com','nomail.today','nomailplease.com','nomailthanks.com','nomailfor.me','nomailforme.com','nomoreinbox.com','nomorespam.com','nomorespam.net','nomorespam.org',
    'spamhole.com','spamhole.net','spamhole.org','spamgourmet.com','spamgourmet.net','spamgourmet.org','spamgourmet.la','spamgourmet.biz','spamgourmet.info','spamgourmet.mobi',
    'mailnesia.com','mailnesia.net','mailnesia.org','mintemail.com','mintemail.net','mintemail.org','tempail.com','tempail.net','tempail.org','fakeinbox.com',
    'fakeinbox.net','fakeinbox.org','fakeemail.com','fakeemail.net','fakeemail.org','emailfake.com','emailfake.net','emailfake.org','dropmail.me','dropmail.net',
    'moakt.co','moakt.com','moakt.net','anonbox.net','anonbox.com','anonbox.org','one-time.email','fastmail.fm','hotmail.com','gmail.com',
    'fastmail.com','protonmail.com','protonmail.ch','tutanota.com','tutanota.de','cock.li','airpo.cc','harakirimail.com','harakirimail.net','harakirimail.org',
    'filzmail.com','filzmail.net','10mail.org','10mail.net','10mail.com','33mail.com','33mail.net','bofthew.com','burneremail.co','burneremail.net',
    'bounceme.net','bounceme.co','caf.vn','centermail.com','centermail.net','chong-mail.com','dandkmail.com','dandkmail.net','dcemail.com','dispostable.com',
    'doesnt-exist.com','doesnotexist.com','dontsendmespam.com','dontsendmespam.net','drdrb.com','drdrb.net','e4ward.com','eintagsmail.de','eintagsmail.com','evade.io',
    'fizmail.com','fizmail.net','flexymail.com','fr33mail.info','gotmail.com','gotmail.net','grr.la','hate.you','hidemail.us','hidemail.net',
    'hotpop.com','hotmail.com (real — but kept for test guard)','hugemail.net','hugemailbox.com','incognitomail.co','incognitomail.com','infer.biz','inboxalias.com','inoutmail.com','itmap.net',
    'kazhala.com','kazhala.net','killmail.net','killmail.com','kook.ml','kurzepost.de','lastmail.co','lastmail.net','letthemeatspam.com','letthemeatspam.net',
    'lifetefl.com','link2mail.net','list.ru','mail2rss.com','mail7.io','mail7.us','mailback.com','mailbucket.org','mailbucket.net','mailcatch.de',
    'mailde.de','maildump.co','maildump.net','maileater.com','maileater.net','maileme.me','mailforspam.com','mailforspam.net','mailin8r.com','mailin8r.net',
    'mailme.com','mailme.net','mailnull.com','mailnull.net','mailsiphon.com','mailsiphon.net','mailslite.com','mailspam.xyz','mailzilla.com','mbox.hu',
    'monster.fastmail.fm','msa.minsmail.com','mypartyclip.de','neomailbox.com','netmails.com','netw0rk.info','nervm.net','nil.so','nomail.xlcrd.com','nothingtoseehere.net',
    'notsharingmy.info','nospamfor.us','nospamthanks.info','nowmymail.com','nurfuerspam.de','ob-ware.de','obamail.us','oneoff.email','opl.vg','paplease.com',
    'pizza.racing','plattform.de','poofy.org','prtn.net','qip.ru','qis.os','qwertyfoo.com','rackets.ru','rabie401.com','rpp.pe',
    'rude.it','royal.net','rtrtr.com','s0ny.net','safe-mail.net','samsplay.com','scatmania.com','seitaiyakkyu.com','sendmail4free.tk','sexner.com',
    'shinnai.com','sibmail.com','siblings.nl','sino.tw','sogetthis.com','soodomail.com','soodomail.net','spam4.me','spamchamp.com','spamcow.com',
    'spamhole.net','spamify.com','spamit.com','spaml.com','spamnull.com','spamsalad.org','spamwc.net','speedgavin.de','sprint.yi.org','ss.tynker.com',
    'stinkfoot.us','stop-my-spam.com','supergreatmail.com','suremail.info','svenskaspelare.se','sweetxxx.de','tafatti.com','talkinator.com','techcentaur.com',
    'thepancakes.ninja','thewiki.club','throwawayemailaddress.com','temporaryemail.net','thisisnotmyrealemail.com','thrma.com','trash-anything.com','trash2009.com','trashmail.at','traysi.net',
    'trendacina.com','trbvm.com','ttjlyo.com','turual.com','tvchao.com','tvet.br','u32.ir','ucraft.com','uglyrock.com','umail.ir',
    'unfinished.name','upliftnow.com','urfunktion.se','ux.doesntexist.org','v3.sk','vomoto.com','voxelcore.com','vubby.com','vs3d.com','w3internet.co.uk',
    'weirdkink.com','wh4ff.org','wilemail.com','wmd-softworks.de','woood.xyz','workmail1.net','worldspace.link','woz.net','wptest.io','xfiles.tw',
    'xfinity.comcast.net','xioox.com','xmail.com','xoxy.net','xrays.digital','xspeeds.eu','xvalue.xyz','xz.cz','xxhamster.xxx','yagg.com',
    'yak.net','yandex-team.ru','yep.it','yerm.com','ymd.ie','yopmail.com','yopmail.fr','yopmail.net','yopsmail.com','yourlottoshop.de',
    'yyh.de','zaks.net','zayne.ca','zcubes.com','zd.ht','zener.me','zetta.li','ziplip.com','zippymail.info','zombie-hive.com',
    'zone.eu','zuw.me','zzz.com','mail.tm','mail.gw','1secmail.com','1secmail.net','1secmail.org','yopmail.com','guerrillamail.com',
    'temp-mail.org','tempmail.com','10minutemail.com','throwawaymail.com','getnada.com','maildrop.cc','trashmail.com','sharklasers.com','spamgourmet.com','mailcatch.com',
    'mailnesia.com','mintemail.com','tempail.com','fakeinbox.com','emailfake.com','dropmail.me','moakt.co','anonbox.net','one-time.email','harakirimail.com',
    '10mail.org','33mail.com','burneremail.co','dispostable.com','hidemail.us','incognitomail.com','killmail.com','lastmail.co','letthemeatspam.com','mail7.io',
    'mailforspam.com','mailin8r.com','mailnull.com','mailsiphon.com','nospamfor.us','nurfuerspam.de','oneoff.email','paplease.com','sogetthis.com','spamhole.com',
    'spamify.com','spamsalad.org','stop-my-spam.com','suremail.info','throwawayemailaddress.com','trashmail.io','trbvm.com','vomoto.com','workmail1.net','yopmail.net'
  ];
  const extras = new Set();
  for (const d of base) {
    const cleaned = String(d).toLowerCase().trim().replace(/^\s*www\./, '').replace(/\s*\(.*\)\s*/g, '');
    if (!cleaned || cleaned.includes(' ')) continue;
    extras.add(cleaned);
    if (cleaned.startsWith('guerrillamail')) {
      extras.add('guerrillamail.com');
      extras.add('guerrillamail.net');
      extras.add('guerrillamail.org');
      extras.add('guerrillamail.de');
      extras.add('guerrillamailblock.com');
      extras.add('sharklasers.com');
    }
    if (cleaned.startsWith('temp-mail')) {
      extras.add('temp-mail.org');
      extras.add('temp-mail.ru');
      extras.add('temp-mail.io');
    }
    if (cleaned.startsWith('tempmail')) {
      extras.add('tempmail.com');
      extras.add('tempmail.net');
      extras.add('tempmail.org');
    }
    if (cleaned.startsWith('10minutemail')) {
      extras.add('10minutemail.com');
      extras.add('10minutemail.net');
    }
    if (cleaned.startsWith('yopmail')) {
      extras.add('yopmail.com');
      extras.add('yopmail.fr');
      extras.add('yopmail.net');
    }
  }
  // Filter out real providers
  const realProviders = new Set(['gmail.com','hotmail.com','outlook.com','yahoo.com','yahoo.co.in','rediffmail.com','protonmail.com','protonmail.ch','tutanota.com','tutanota.de','fastmail.com','fastmail.fm','icloud.com','me.com','mac.com','aol.com','zoho.com','gmx.com','gmx.net','gmx.de','mail.com','yandex.com','yandex.ru','outlook.in','hotmail.co.uk','outlook.co.uk','yahoo.co.uk','live.com','live.in','msn.com','hotmail.es','outlook.es','yahoo.es','wanadoo.fr','orange.fr','sfr.fr','free.fr','laposte.net','alice.it','libero.it','virgilio.it','tin.it','web.de','gmx.de','freenet.de','arcor.de','t-online.de','online.no','yahoo.se','gmail.com']);
  for (const rp of realProviders) extras.delete(rp);
  _domains = extras;
  return _domains;
};

const DISPOSABLE_DOMAINS = buildList();

const isDisposableEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  let domain = email.slice(at + 1).toLowerCase().trim().replace(/^\s*www\./, '');
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  for (const root of DISPOSABLE_DOMAINS) {
    if (domain === root) return true;
    if (domain.endsWith('.' + root)) return true;
  }
  return false;
};

module.exports = { DISPOSABLE_DOMAINS, isDisposableEmail };
