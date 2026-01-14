import { RedisCache } from '../cache/redis';

const TRACKERS_LIST_CACHE_KEY = 'dynamic_trackers_list';
const TRACKERS_LIST_CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours

const TRACKERS_LIST_URLS = [
    "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt",
    "https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best_ip.txt",
    "https://ngosang.github.io/trackerslist/trackers_best_ip.txt",
];

export const STATIC_ADDITIONAL_TRACKERS = [
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://p4p.arenabg.com:1337/announce",
	"udp://retracker.hotplug.ru:2710/announce",
	"http://tracker.bt4g.com:2095/announce",
	"http://bt.okmp3.ru:2710/announce",
	"udp://tracker.torrent.eu.org:451/announce",
	"http://tracker.mywaifu.best:6969/announce",
	"udp://ttk2.nbaonlineservice.com:6969/announce",
	"http://tracker.privateseedbox.xyz:2710/announce",
	"udp://evan.im:6969/announce",
	"https://tracker.yemekyedim.com:443/announce",
	"udp://retracker.lanta.me:2710/announce",
	"udp://martin-gebhardt.eu:25/announce",
	"http://tracker.beeimg.com:6969/announce",
	"udp://udp.tracker.projectk.org:23333/announce",
	"http://tracker.renfei.net:8080/announce",
	"https://tracker.expli.top:443/announce",
	"https://tr.nyacat.pw:443/announce",
	"udp://tracker.ducks.party:1984/announce",
	"udp://extracker.dahrkael.net:6969/announce",
	"http://ipv4.rer.lol:2710/announce",
	"udp://tracker.plx.im:6969/announce",
	"udp://tracker.tvunderground.org.ru:3218/announce",
	"http://tracker.tricitytorrents.com:2710/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.dler.com:6969/announce",
	"https://tracker.moeblog.cn:443/announce",
	"udp://d40969.acod.regrucolo.ru:6969/announce",
	"https://tracker.jdx3.org:443/announce",
	"http://ipv6.rer.lol:6969/announce",
	"udp://bandito.byterunner.io:6969/announce",
	"udp://tracker.gigantino.net:6969/announce",
	"http://tracker.netmap.top:6969/announce",
	"udp://tracker.yume-hatsuyuki.moe:6969/announce",
	"https://tracker.aburaya.live:443/announce",
	"udp://tracker.srv00.com:6969/announce",
	"udp://open.demonii.com:1337/announce",
	"udp://1c.premierzal.ru:6969/announce",
	"udp://tracker.fnix.net:6969/announce",
	"udp://tracker.kmzs123.cn:17272/announce",
	"https://tracker.home.kmzs123.cn:4443/announce",
	"udp://tracker-udp.gbitt.info:80/announce",
	"udp://tracker.torrust-demo.com:6969/announce",
	"udp://tracker.hifimarket.in:2710/announce",
	"udp://retracker01-msk-virt.corbina.net:80/announce",
	"https://tracker.ghostchu-services.top:443/announce",
	"udp://open.dstud.io:6969/announce",
	"udp://tracker.therarbg.to:6969/announce",
	"udp://tracker.bitcoinindia.space:6969/announce",
	"udp://www.torrent.eu.org:451/announce",
	"udp://tracker.hifitechindia.com:6969/announce",
	"udp://tracker.gmi.gd:6969/announce",
	"udp://tracker.skillindia.site:6969/announce",
	"http://tracker.ipv6tracker.ru:80/announce",
	"udp://tracker.tryhackx.org:6969/announce",
	"http://torrent.hificode.in:6969/announce",
	"http://open.trackerlist.xyz:80/announce",
	"http://taciturn-shadow.spb.ru:6969/announce",
	"http://0123456789nonexistent.com:80/announce",
	"http://shubt.net:2710/announce",
	"udp://tracker.valete.tf:9999/announce",
	"https://tracker.zhuqiy.top:443/announce",
	"https://tracker.leechshield.link:443/announce",
	"http://tracker.tritan.gg:8080/announce",
	"udp://t.overflow.biz:6969/announce",
	"udp://open.tracker.cl:1337/announce",
	"udp://explodie.org:6969/announce",
	"udp://exodus.desync.com:6969/announce",
	"udp://bt.ktrackers.com:6666/announce",
	"udp://wepzone.net:6969/announce",
	"udp://tracker2.dler.org:80/announce",
	"udp://tracker.theoks.net:6969/announce",
	"udp://tracker.ololosh.space:6969/announce",
	"udp://tracker.filemail.com:6969/announce",
	"udp://tracker.dump.cl:6969/announce",
	"udp://tracker.dler.org:6969/announce",
	"udp://tracker.bittor.pw:1337/announce",
];

export async function getAdditionalTrackers(redisCache: RedisCache): Promise<string[]> {
    // Try cache
    const cached = await redisCache.get(TRACKERS_LIST_CACHE_KEY);
    if (cached) {
        try {
            const trackers = JSON.parse(cached);
            if (Array.isArray(trackers) && trackers.length > 0) {
                return trackers;
            }
        } catch (e) {
            console.error('Failed to parse cached trackers', e);
        }
    }

    // Fetch from URLs
    for (const url of TRACKERS_LIST_URLS) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const text = await response.text();
            const trackers = text.split('\n').map(t => t.trim()).filter(t => t.length > 0);
            
            if (trackers.length > 0) {
                await redisCache.set(TRACKERS_LIST_CACHE_KEY, JSON.stringify(trackers), TRACKERS_LIST_CACHE_EXPIRATION);
                return trackers;
            }
        } catch (e) {
            console.warn(`Failed to fetch trackers from ${url}`, e);
        }
    }

    return STATIC_ADDITIONAL_TRACKERS;
}
