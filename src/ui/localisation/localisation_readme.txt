
[ADDING NEW LANGUAGES]

Each pack is to be named as follows: [IETF language tag].json

It is then to be imported into the i18n.js file, and added to the resources object. 

New language packs will be as follows:
{
    "translation": {

    }
}

[ADDING NEW TRANSLATED PHRASES]
Within the translation object, each key-value pair will be a separate translation. The keys identify what phrase you want for the given language. 
The value is the phrase in that specific language.
I.e. a waiting screen might have "PleaseWait" as the key. And then the value in English might be "Please Wait" while in Italian it might be "Attendere prego".

!!! The keys should be IDENTICAL for every language pack. If they are not identical, the phrase will not get translated to your language.!!!


[LANGUAGE CAVEAT]
So unfortunately i'm a developer, not a translator. So the example phrases i've put in for the languages are straight from google translate or chatGPT. 
These other languages are there for the purposes of testing.