let net = require('net');
let fs = require('fs');
let dgram = require('dgram');
var localIpV4Address = require("local-ipv4-address");
const { exit } = require('process');
const { Buffer } = require('buffer');
const { match } = require('assert');
const { executionAsyncResource } = require('async_hooks');

var commands={};
let cdata=fs.readFileSync('commands.json',{encoding:'utf8', flag:'r'})

try{ 
    commands=JSON.parse(cdata);
}catch(e){
    console.log(e);
}

var myargs = process.argv.slice(2);

console.log("!!! 0. Please connect to the datalogger wifi access point or ensure the device is accessible on your network !!!");
console.log("!!! On initial setup the datalogger ip address is the gateway (obtained by dhcp from the datalogger wifi AP) !!!");

console.log("\nUSAGE: COMMAND [options]\n\nCOMMANDS:")
commands.commandsequences.forEach(function(cs){
    console.log(cs.name+" "+cs.args+" \n ("+cs.desc+")\n");
});

console.log("\n");

var global_commandsequence=""; //run more commands after another
var global_commandparam=""; //run more paramterter for 1 command
var global_tcp_seq=1; //sends the device in every command: modbus transaction id

if (myargs.length==0){
    console.log("\n No command supplied! ");
}else{

    commands.commandsequences.forEach(function(cs){
        
        if (cs.name===myargs[0]){
            
            global_commandsequence=myargs[0];
            console.log("Running: "+global_commandsequence);

            argscount=[];
            cs.seq.forEach(function(cd){
                let nc=commands.commands.find(cdf => cdf.name === cd);
                
                let reg=nc.cmd.match(/\{ARG[PV]*[0-9]+\}/g);
                if (reg!=null && reg!==false && reg!=undefined ) argscount=argscount.concat(reg);

                //console.log(nc);
                if (nc.hasOwnProperty('definition') && Array.isArray(nc.definition)){
                    //console.log("gpn!!!4");
                    //exit(0);
                    global_commandparam=0;
                }
                
            });
           
            var arguniq=argscount.filter((v, i, a) => a.indexOf(v) === i);
            
            if (myargs.length<arguniq.length+2) {
                console.log("Wrong number of arguments! Exiting...");
                exit(-1);
            }

            sendudp(myargs[1]);

        }

    });

}


function sendudp(devip){

    try{

        localIpV4Address().then(function(ip){

            //ip="192.168.89.254";
            
            console.log("Using local ip to create TCP server: "+(ip));

            starttcp();

            var client = dgram.createSocket('udp4');
            let port=58899;
            let command="set>server="+ip+":8899;";
            
            console.log("Sending UDP packet(port: "+port+") to inform datalogger device to connect the TCP server:");
            console.log(command);

            client.on('listening', function () {
                var address = client.address();
                console.log('UDP server listening on ' + address.address + ":" + address.port);
            });

            client.on('error', (err) => {
                console.log(`UDP server error:\n${err.stack}`);
                client.close();
            });

            client.on('message',function(message, remote){
                console.log(remote.address + ':' + remote.port +' - ' + message);
            });

            client.send(command,0, command.length, port, devip);

        });

    }catch(e){
        console.log("Error: ",e);
        exit(-1);
    }
    
}

function starttcp(){

    let port=8899;
    let command_seq=0;

    console.log("starting TCP server(port: "+port+") to recieve data....");

    var server = net.createServer(function(socket) {

        console.log(`${socket.remoteAddress}:${socket.remotePort} connected on TCP`);
        
        let outsum="\n";
        let outobj={};

        //socket.pipe(socket);
        socket.on('data',function(data){
            //console.log("Got TCP packet...");
            //dumpdata(data);
            //console.log("Binary: ",data.toString());
            //console.log("\n");

            let lastcmdname=getcommseqcmd(command_seq-1);
            //console.log(lastcmdname);
            let lastcmddef = commands.commands.find(e => e.name === lastcmdname);
            //console.log(lastcmddef);
            if (global_commandparam!=="" && lastcmddef!==undefined && lastcmddef!==null && lastcmddef.hasOwnProperty('definition')){
                
                let handled=[];
                lastcmddef.definition.forEach(function(def,ind){

                    if (global_commandparam!==""){
                        if (ind!=global_commandparam) {
                            return ;
                        }
                    } else {
                        
                        return;
                    }

                    //modbus rtu response: fixed position to extract data from
                    let val="";
                    val=data.toString('hex');

                    process.stdout.write("Response orig:\n");
                    dumpdata(data);

                    //data starts at byte 11
                    startpos=11;

                    //1 byte len
                    lenval=data[10];
                    
                    let tmpbuf=data.slice(8,data.length-2);
                    let rcrc=data.slice(data.length-2,data.length);
                    //dumpdata(rcrc);
                    rcrc=rcrc.readUInt16BE().toString(16).padStart(4,'0');
                    //dumpdata(tmpbuf);
                    let chcrc=crc16modbus(tmpbuf);
                    chcrc=chcrc.toString(16).padStart(4,'0');
    
                    let hcrc=chcrc.substring(2)+chcrc.substring(0,2);
                    
                    console.log("(Response info len: "+lenval+" Data type: "+def.type+" "+"CRC check: "+hcrc+" "+rcrc+")");

                    if (hcrc!=rcrc){

                        let outt=(def.hasOwnProperty('num')?def.num.padStart(2,'0')+" ":"")+def.name+":\t \t NA : ERROR IN RESPONSE!";
                        console.log(outt);

                        outobj[def.name]="N/A";
                        outsum+=outt+"\n";

                    }else{

                        //custom formats
                        if ( Number.isInteger(def.type) ){

                            //type with custom length: not needed -> string default
                            //val=val.substring(startpos*2,startpos*2+(lenval*2));

                            for(let c=0;c<lenval*2;c++){
                                handled[startpos*2+c]=1;
                            }
                            
                            //default handle as string
                            let nb=data.slice(startpos,startpos+lenval);
                            nb=nb.toString('utf8').replace(/\0/g, '');

                            if (def.hasOwnProperty('format')){
                                //datetime
                                if (def.format===100){
                                    nb= "20"+data.readUInt8(startpos+lenval-6).toString()+"-"+
                                        data.readUInt8(startpos+lenval-5).toString()+"-"+
                                        data.readUInt8(startpos+lenval-4).toString()+" "+
                                        data.readUInt8(startpos+lenval-3).toString()+":"+
                                        data.readUInt8(startpos+lenval-2).toString()+":"+
                                        data.readUInt8(startpos+lenval-1).toString();
                                }
                                //fault codes
                                if (def.format===101){
                                    nb = "FAULT0: "+data.readUInt16BE(startpos)+": "+def.unit[data.readUInt16BE(startpos)]+" "+
                                        "FAULT1: "+data.readUInt16BE(startpos+2)+": "+def.unit[data.readUInt16BE(startpos+2)]+" "+
                                        "FAULT2: "+data.readUInt16BE(startpos+4)+": "+def.unit[data.readUInt16BE(startpos+4)]+" "+
                                        "FAULT3: "+data.readUInt16BE(startpos+6)+": "+def.unit[data.readUInt16BE(startpos+6)]+" ";
                                        
                                }
                            }
                            
                            val=nb;
                        
                        }else{

                            //basic types supported by Buffer class: most seem to be 2 byte long
                            val=data['read'+def.type](startpos);

                            //hack: mark always 2 bytes: just for debugging
                            handled[startpos*2]=1;
                            handled[startpos*2+1]=1;
                            handled[startpos*2+2]=1;
                            handled[startpos*2+3]=1;

                            if (def.hasOwnProperty('rate')){
                                val=val*def.rate;
                            }
                             
                            if (def.hasOwnProperty('format')){
                                val=val.toFixed(def.format);
                            }
                            
                        }

                        let stmp=(def.hasOwnProperty('num')?def.num.padStart(2,'0')+" ":"")+def.name+":\t \t "+val+" "+(Array.isArray(def.unit)?( def.unit[parseInt(val)]!==undefined? (" => "+def.unit[parseInt(val)]): '' ):def.unit);
                        console.log(stmp);
                        outobj[def.name]=val;
                        outsum+=stmp+"\n";
                        
                    }    

                    process.stdout.write("Response:\n");
                    dumpdata(data,handled);
                    
                });

                if (global_commandparam!=="" && lastcmddef.definition.length>global_commandparam+1){
                    global_commandparam++;
                    //run again with another param
                    command_seq--;
                }
            }else{
                process.stdout.write("Response:\n");
                dumpdata(data);
            }

            let cmdstr=getcommseqcmd(command_seq);
            
            if (cmdstr === undefined) { 
                console.log(outsum);
                console.log("JSON output:\n",outobj);
                console.log("DONE, exiting"); 
                exit(0);
            }
               
            socket.write(getdatacmd(cmdstr));
            command_seq++;
            
        });

        socket.on('error',function(error){
            console.error(`${socket.remoteAddress}:${socket.remotePort} Connection Error ${error}..., exiting...`);
            exit(-1);
        });

        socket.on('close',function(){
            console.log(`${socket.remoteAddress}:${socket.remotePort} Connection closed, exiting...`);
            exit(-1);
        });

        let cmdstr=getcommseqcmd(command_seq);
        if (cmdstr === undefined) { console.log("Missing command sequence, exiting..."); exit(-1); }

        
        let tw=getdatacmd(cmdstr);
        //console.log("write:",tw);
        socket.write(tw);
        command_seq++;

    });

    server.listen(port, '0.0.0.0');

}


//get next command for the commany sequence by index
function getcommseqcmd(index){

    let obj=commands.commandsequences.find(o => o.name === global_commandsequence );
    return obj.seq[index];
}

function getdatacmd(data){

    console.log("\nCommand: "+data);

    let obj=commands.commands.find(o => o.name === data );
    //definition array link following
    if (typeof obj.definition === 'string'){
        obj.definition=commands.commands.find(o => o.name === obj.definition ).definition;
    }

    let cmdtorun=obj.cmd;
    //place simple input args in modbus commands
    let i=0;
    myargs.forEach(function(el){

        let hext=Buffer.from(el, 'utf8').toString('hex');
        if (obj.hasOwnProperty('raw') && obj.raw===true){
            hext=el;
        }
        cmdtorun=obj.cmd.replace('{ARG'+i+'}',hext);
        i++;
    });

    //custom built modbus command
    cmdtorun=handle_modbus_command(cmdtorun,obj);

    //compute and place length where needed
    let matches=cmdtorun.match(/\{LEN\}(.+)$/);
    if (matches) {
        cmdtorun=cmdtorun.replace("{LEN}",(matches[1].length/2).toString(16).padStart(4, '0'));
    }

    //add modbus tcp transaction id, just an incemental index
    cmdtorun=cmdtorun.replace('{SEQ}',String(global_tcp_seq).padStart(4, '0'));
    global_tcp_seq++;

    process.stdout.write("Request: ");
    dumpdata(cmdtorun);
    

    return Buffer.from(cmdtorun, 'hex');
}

function getparam(cmd,ind){

    let param=cmd.definition.find(o => o.num === ind );
    if (param!==undefined) {
        console.log("Requested param: "+param.name);
        return param;
    }
    return "";    
}

//hex dump
function dumpdata(data,handled=null){

    let strdata=data.toString('hex');
    
    let out="";
    let i=1;
    [...strdata].forEach(element => {
        
        bgred="\x1b[42m";
        normal="\x1b[0m";

        if (Array.isArray(handled)){
            if (handled[i-1]==1) {
                out+=bgred;
            }    
        }
        out+=element;
        if (Array.isArray(handled)){
            if (handled[i-1]==1) {
                out+=normal;
            }
        }    

        if (i%2==0) {     
            out+=" ";
        }

        if (i%16==0) {
            out+="  ";
        }

        if (i%32==0) {
            out+="\n";
        }

        i++;

    });

    console.log(out);

}

function handle_modbus_command(command,cmd) {

    if (!command.match(/{CRC}/)) return command;
   
    let addr = "";
    let type = "";

    if (global_commandparam!==""){
        addr = cmd.definition[global_commandparam].address;
        type = cmd.definition[global_commandparam].type;
        console.log("Querying param: "+cmd.definition[global_commandparam].name+"\n");
    }
    
    let reqlen='0001'; //modbus defines 16bytes, some complex data are stored on multiple registers
    if (Number.isInteger(type)){
        reqlen=type.toString(16).padStart(4,'0');
    }
        
    command=command.replace('{PARAM}',addr+reqlen);

    
    //HANDLE set command...    
    let setparam="";
    let setparamind=0;
    let setval="";
    let setvalind=0;

    //get args and connected data
    let i=0;
    myargs.forEach(function(el) {

        if ( command.indexOf('{ARGP'+i+'}')!==-1) {
            setparamind=i;
            setparam=cmd.definition.find(o => o.num === el );
        }

        if ( command.indexOf('{ARGV'+i+'}')!==-1) {
            setvalind=i;
            setval=el;
        }

        i++;
    });

    //console.log(setparam);
    //console.log(setval);

    if (setparam!="" && setval!="") {

        if ( command.indexOf('{ARGP'+setparamind+'}')!==-1) {

            //default 1 register            
            let reglen="0001";
            if (Number.isInteger(setparam.type)) {
                reglen=setparam.type.toString(16).padStart(4,'0');
                console.log("Error: Not supported type:", setparam.type);
                exit(-1);
            }    

            let specargparam=setparam.address+reglen;
            command=command.replace('{ARGP'+setparamind+'}',specargparam);
            
        }

        if ( command.indexOf('{ARGV'+setvalind+'}')!==-1) {
            //default 2 bytes
            let deflen='02';
            let rv='0000';

            if (Array.isArray(setparam.unit)) {
                let listval=setparam.unit.indexOf(setval);
                if (listval===-1){
                    console.log("Error: The requested value is not valid, values:", setparam.unit);
                    exit(-1);
                }
                if (Number.isInteger(listval)){
                    
                    rv=listval.toString(16).padStart(4,'0');
                }else{
                    console.log("Error: The requested value is not compatible with the parameter type ("+setparam.type+")!");
                    exit(-1);
                }
                
            }else{

                switch (setparam.type) {
                    case "UInt16BE":
                    case "Int16BE":
                        if (setval.match(/^[0-9\.]+$/) ){
                            if (parseInt(setval).toString() === setval){
                                setval=parseInt(setval);    
                            }
                        }else{
                            console.log(setparam);
                            console.log("Error: The requested value ("+setval+") is not compatible with the parameter type!");
                            exit(-1);
                        }
                        
                        setval=Math.round(setval/setparam.rate);
                        rv=setval.toString(16).padStart(4,'0');

                    break;
                    default:
                        console.log(setparam);
                        console.log("Error: The requested parameter is not writable now!");
                        exit(-1);
                }
            }

            //console.log(rv);
            
            let specargval=deflen+rv;
            //console.log("replace:",specargval);
            
            command=command.replace('{ARGV'+setvalind+'}',specargval);
            
        }
        
       
    }
    
    let matches=command.match(/\{LEN\}[a-f0-9A-F]{4}(.+)\{CRC\}$/);
    let inner="";
    if (matches) {
        //{CRC} -> 5 char vs 4char hex(2 byte): -1
        inner=Buffer.from(matches[1],'hex');
    }

    let crc=crc16modbus(inner);
    
    crc=crc.toString(16).padStart(4,'0');
    
    command=command.replace("{CRC}",crc.substring(2)+crc.substring(0,2));

    if (setparam!="" && setval!="") {
        console.log("Constructed modbus RTU command:"+command);
        //console.log("Dry run exiting here....");
        //exit(0);
    }    
        
    return command;

}

function crc16modbus(data){
    
    const table = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400
    ];
    
    let crc = 0xFFFF;

    for (let i = 0; i < data.length; i++) {
        let ch = data[i];
        crc = table[(ch ^ crc) & 15] ^ (crc >> 4);
        crc = table[((ch >> 4) ^ crc) & 15] ^ (crc >> 4);
    }

    return crc;
    
}


function display(){



}