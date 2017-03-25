
const	MAX_APPELS_DYNAMIQUES = 9,
	fmt = require("../../libs/fmt.js"),
	iconvlite = require('iconv-lite'),
	http = require('http'),
	Promise = require("bluebird");

// queries a SP ("script public")
// returns a promise which is resolved if all goes well with an array of arrays of strings (a csv table)
exports.fetchSP = function(sp, num, mdpr){
	var p = Promise.defer();
	var req = http.request({
		hostname: "sp.mountyhall.com",
		path: "/SP_"+sp+".php?Numero="+num+"&Motdepasse="+encodeURIComponent(mdpr),
		method: "GET"
	}, function(res){
		var lines = [];
		res.on('data', function(chunk){
			lines.push(iconvlite.decode(chunk, 'ISO-8859-1').toString().split(';'));
		}).on('end', function(){
			if (lines.length>0 && lines[0].length>1) {
				p.resolve(lines);
			} else {
				p.reject(new Error('Error : ' + JSON.stringify(lines)));
			}
		});
	});
	req.on('error', function(e){
		p.reject(e);
	});
	req.end();
	return p.promise;
}

// must be called with context being an open DB connection
exports.getNbSpCallsInLast24h = function(trollId){
	var since = (Date.now()/1000|0) - 24*60*60;
	return this.queryRow(
		"select count(*) nb from mountyhall_sp_call where troll=$1 and call_date>$2",
		[trollId, since],
		"mh_count_sp_calls"
	)
	.then(function(row){
		return row.nb;
	});
}

// must be called with context being an open DB connection
exports.isPlayerInRoomPartages = function(roomId, playerId){
	return this.queryRow(
		"select count(*) b from mountyhall_partage where room=$1 and player=$2",
		[roomId, playerId],
		"mh_check_player_partage"
	)
	.then(function(row){
		return !!row.b;
	});
}

// must be called with context being an open DB connection
exports.getRoomTrolls = function(roomId){
	return this.queryRows(
		"select player, name from mountyhall_partage mhp join player p on p.id=mhp.player where room=$1",
		[roomId],
		"mh_get_room_partages_and_players"
	)
	.map(function(row){
		return this.getPlayerPluginInfo("MountyHall", row.player)
		.then(function(ppi){
			if (!ppi || !ppi.info || !ppi.info.troll) {
				return null;
			}
			ppi.info.troll.miaouUser = {
				id: row.player,
				name: row.name
			};
			return ppi.info.troll;
		});
	})
	.filter(Boolean);
}


// Returns recent sp requests as a markdown table
// must be called with context being an open DB connection
exports.mdRecentSPRequests = function(trollIds, playerIds){
	var since = Date.now()/1000|0 - 3*24*60;
	var cond = "requester in(" + playerIds + ")";
	if (trollIds.length) cond = "(troll in ("+trollIds+") or " + cond + ")";
	return this.queryRows(
		"select troll, call_date, requester, name, script, sp_result from mountyhall_sp_call"+
		" left join player on player.id=requester"+
		" where " + cond+
		" and call_date>"+since+
		" order by call_date desc",
		null,
		"select_requests", false
	)
	.then(function(rows){
		if (!rows.length) return "pas de requète dans les trois derniers jours";
		return	"Date|Troll|Demandeur|Script|Résultat\n"
		+ ":-:|:-:|:-:|:-:|:-:\n"
		+ rows.map(r =>
			`${fmt.date(r.call_date, "YYYY/MM/DD hh:mm")}|${r.troll}|${r.name}|${r.script}|${r.sp_result}`
		).join("\n");
	});
}

// must be called with context being an open DB connection
exports.updateTroll = function(playerId, requester){
	console.log("updating troll for player", playerId);
	var	now = Date.now()/1000|0,
		troll,
		ppi,
		script = 'Profil2';
	return this.getPlayerPluginInfo("MountyHall", playerId)
	.then(function(_ppi){
		ppi = _ppi;
		console.log('ppi:', ppi);
		if (!ppi || !ppi.info) throw "Vous devez lier un troll à votre utilisateur Miaou (voir les *settings*)";
		troll = ppi.info.troll;
		console.log('troll:', troll);
		if (!troll) throw "Troll non trouvé";
		if (!ppi.info.mdpr) throw "Mot de passe restreint inconnu de Miaou";
		return exports.getNbSpCallsInLast24h.call(this, troll.id);
	})
	.then(function(nbCalls){
		console.log('nbCalls:', nbCalls);
		if (nbCalls>MAX_APPELS_DYNAMIQUES) {
			throw `Trop d'appels aux scripts publics pour le troll ${troll.id}`;
		}
		return exports.fetchSP(script, troll.id, ppi.info.mdpr)
		.catch(spError=>{
			console.log('spError:', spError);
			var badPassword = /mot de passe incorrect/.test(spError.toString());
			return this.execute(
				"insert into mountyhall_sp_call (troll, call_date, requester, script, sp_result)"+
				" values ($1, $2, $3, $4, $5)",
				[troll.id, now, requester, script, badPassword ? "bad-password" : "error"],
				"mh_insert_sp_call"
			).then(function(){
				throw `L'appel du script public ${script} a échoué`;
			});
		})
		.then(csv=>{
			console.log('csv:', csv);
			return this.execute(
				"insert into mountyhall_sp_call (troll, call_date, requester, script, sp_result)"+
				" values ($1, $2, $3, $4, $5)",
				[troll.id, now, requester, script, "ok"],
				"mh_insert_sp_call"
			).then(function(){
				return profil2CsvToObject(csv);
			});
		});
	})
	.then(function(profil2){
		console.log('profil2:', profil2);
		profil2.requestTime = now;
		ppi.info.troll.profil2 = profil2;
		return this.deletePlayerPluginInfo("MountyHall", playerId);
	}).then(function(){
		return this.storePlayerPluginInfo("MountyHall", playerId, ppi.info);
	}).then(function(){
		return ppi.info.troll;
	});
}

function profil2CsvToObject(csv){
	var	l = csv[0].map(v=>v==+v?+v:v),
		i = 0;
	return {
		id: l[i++],
		x: l[i++],
		y: l[i++],
		n: l[i++],
		pv: l[i++],
		pvPasMax: l[i++],
		pa: l[i++],
		dla: Date.parse(l[i++])/1000|0, // ceci marche uniquement si le serveur est en TimeZone CET
		désAtt: l[i++],
		désEsq: l[i++],
		désDég: l[i++],
		désReg: l[i++],
		vue: l[i++],
		arm: l[i++],
		mm: l[i++],
		rm: l[i++],
		atts: l[i++],
		fat: l[i++],
		cam: !!l[i++],
		invi: !!l[i++],
		int: !!l[i++],
		parades: l[i++],
		contras: l[i++],
		dur: l[i++],
		bonDur: l[i++],
		armNat: l[i++],
		mDésArmNat: l[i++],
		glué: !!l[i++],
		auSol: !!l[i++],
		course: !!l[i++],
		lévite: !!l[i++],
		pvMax: l[i++],
		niveau: l[i++]
	};
}
