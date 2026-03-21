use frost_secp256k1 as frost;
use frost::keys::dkg;
use frost::Identifier;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(tag = "command")]
enum Command {
    #[serde(rename = "dkg-part1")]
    DkgPart1 {
        identifier: u16,
        max_signers: u16,
        min_signers: u16,
    },
    #[serde(rename = "dkg-part2")]
    DkgPart2 {
        round1_secret_package: String,
        #[serde(deserialize_with = "deserialize_str_keys")]
        round1_packages: BTreeMap<u16, String>,
    },
    #[serde(rename = "dkg-part3")]
    DkgPart3 {
        round2_secret_package: String,
        #[serde(deserialize_with = "deserialize_str_keys")]
        round1_packages: BTreeMap<u16, String>,
        #[serde(deserialize_with = "deserialize_str_keys")]
        round2_packages: BTreeMap<u16, String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "result")]
enum Response {
    #[serde(rename = "dkg-part1")]
    DkgPart1 {
        secret_package: String,
        round1_package: String,
    },
    #[serde(rename = "dkg-part2")]
    DkgPart2 {
        secret_package: String,
        round2_packages: BTreeMap<u16, String>,
    },
    #[serde(rename = "dkg-part3")]
    DkgPart3 {
        key_package: String,
        public_key_package: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

fn deserialize_str_keys<'de, D>(deserializer: D) -> Result<BTreeMap<u16, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let map: BTreeMap<String, String> = BTreeMap::deserialize(deserializer)?;
    map.into_iter()
        .map(|(k, v)| {
            k.parse::<u16>()
                .map(|k| (k, v))
                .map_err(serde::de::Error::custom)
        })
        .collect()
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let response = match serde_json::from_str::<Command>(&input) {
        Ok(cmd) => execute(cmd),
        Err(e) => Response::Error {
            message: format!("Invalid input: {e}"),
        },
    };

    println!("{}", serde_json::to_string(&response).unwrap());
}

fn execute(cmd: Command) -> Response {
    match cmd {
        Command::DkgPart1 { identifier, max_signers, min_signers } =>
            run_part1(identifier, max_signers, min_signers),
        Command::DkgPart2 { round1_secret_package, round1_packages } =>
            run_part2(&round1_secret_package, &round1_packages),
        Command::DkgPart3 { round2_secret_package, round1_packages, round2_packages } =>
            run_part3(&round2_secret_package, &round1_packages, &round2_packages),
    }
}

fn run_part1(identifier: u16, max_signers: u16, min_signers: u16) -> Response {
    let id = match Identifier::try_from(identifier) {
        Ok(id) => id,
        Err(e) => return Response::Error { message: format!("Invalid identifier: {e}") },
    };

    let (secret_package, round1_package) =
        match dkg::part1(id, max_signers, min_signers, &mut OsRng) {
            Ok(result) => result,
            Err(e) => return Response::Error { message: format!("DKG part1 failed: {e}") },
        };

    Response::DkgPart1 {
        secret_package: hex::encode(postcard::to_allocvec(&secret_package).unwrap()),
        round1_package: hex::encode(postcard::to_allocvec(&round1_package).unwrap()),
    }
}

fn run_part2(
    round1_secret_hex: &str,
    round1_packages_hex: &BTreeMap<u16, String>,
) -> Response {
    let secret_package: dkg::round1::SecretPackage =
        match postcard::from_bytes(&hex::decode(round1_secret_hex).unwrap()) {
            Ok(p) => p,
            Err(e) => return Response::Error { message: format!("Deserialize secret: {e}") },
        };

    let mut id_to_u16: BTreeMap<Identifier, u16> = BTreeMap::new();
    let mut round1_packages = BTreeMap::new();
    for (id, pkg_hex) in round1_packages_hex {
        let identifier = Identifier::try_from(*id).unwrap();
        id_to_u16.insert(identifier, *id);
        let pkg: dkg::round1::Package =
            postcard::from_bytes(&hex::decode(pkg_hex).unwrap()).unwrap();
        round1_packages.insert(identifier, pkg);
    }

    let (secret_package2, round2_packages) =
        match dkg::part2(secret_package, &round1_packages) {
            Ok(result) => result,
            Err(e) => return Response::Error { message: format!("DKG part2 failed: {e}") },
        };

    let mut round2_hex = BTreeMap::new();
    for (id, pkg) in &round2_packages {
        let id_key = *id_to_u16.get(id).expect("unknown identifier in round2 output");
        round2_hex.insert(id_key, hex::encode(postcard::to_allocvec(pkg).unwrap()));
    }

    Response::DkgPart2 {
        secret_package: hex::encode(postcard::to_allocvec(&secret_package2).unwrap()),
        round2_packages: round2_hex,
    }
}

fn run_part3(
    round2_secret_hex: &str,
    round1_packages_hex: &BTreeMap<u16, String>,
    round2_packages_hex: &BTreeMap<u16, String>,
) -> Response {
    let secret_package: dkg::round2::SecretPackage =
        match postcard::from_bytes(&hex::decode(round2_secret_hex).unwrap()) {
            Ok(p) => p,
            Err(e) => return Response::Error { message: format!("Deserialize secret: {e}") },
        };

    let mut round1_packages = BTreeMap::new();
    for (id, pkg_hex) in round1_packages_hex {
        let id = Identifier::try_from(*id).unwrap();
        let pkg: dkg::round1::Package =
            postcard::from_bytes(&hex::decode(pkg_hex).unwrap()).unwrap();
        round1_packages.insert(id, pkg);
    }

    let mut round2_packages = BTreeMap::new();
    for (id, pkg_hex) in round2_packages_hex {
        let id = Identifier::try_from(*id).unwrap();
        let pkg: dkg::round2::Package =
            postcard::from_bytes(&hex::decode(pkg_hex).unwrap()).unwrap();
        round2_packages.insert(id, pkg);
    }

    let (key_package, public_key_package) =
        match dkg::part3(&secret_package, &round1_packages, &round2_packages) {
            Ok(result) => result,
            Err(e) => return Response::Error { message: format!("DKG part3 failed: {e}") },
        };

    Response::DkgPart3 {
        key_package: hex::encode(postcard::to_allocvec(&key_package).unwrap()),
        public_key_package: hex::encode(postcard::to_allocvec(&public_key_package).unwrap()),
    }
}
